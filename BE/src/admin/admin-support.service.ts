import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import { AuditEvent, AuditService } from '../audit/audit.service';
import { likeLiteral } from '../common/like';
import { FunctionLogsQuery, FunctionLogsView } from '../functions/dto/function-logs.dto';
import { FunctionInvocation, InvocationStatus } from '../functions/entities/function-invocation.entity';
import { Function } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { AdminAccountsService } from './admin-accounts.service';
import { AdminCallDataView, AdminCallHitView, AdminCallView, AdminCodeView, AdminFunctionHitView, AdminFunctionPageView, AdminSearchView } from './admin-support.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILED = [InvocationStatus.ERROR, InvocationStatus.TIMEOUT, InvocationStatus.THROTTLED, InvocationStatus.LOST];
/** A usage record's outcome, as the invocation history names it. */
const AS_INVOCATION_STATUS: Record<string, InvocationStatus> = {
  success: InvocationStatus.COMPLETED,
  error: InvocationStatus.ERROR,
  timeout: InvocationStatus.TIMEOUT,
  throttled: InvocationStatus.THROTTLED,
  platform_error: InvocationStatus.ERROR,
  lost: InvocationStatus.LOST,
};
const LOAD_FAILURE = 'The function failed to load: ';

/**
 * A failed call's error type, without its message: "ValidationError",
 * "Sandbox.Timedout". The message comes from the customer's code and may hold
 * their users' data, so support reads it only for a reason. FF's own wording
 * of a failure on its side, or of a lost call, has no type: null.
 */
export function errorType(error: string | null | undefined): string | null {
  if (!error) return null;
  const text = error.startsWith(LOAD_FAILURE) ? error.slice(LOAD_FAILURE.length) : error;
  return /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*): /.exec(text)?.[1] ?? null;
}

const callView = (invocation: FunctionInvocation): AdminCallView => ({
  id: invocation.id,
  status: invocation.status,
  duration: invocation.duration,
  memoryUsed: invocation.memoryUsed ?? null,
  createdAt: invocation.createdAt,
  errorType: errorType(invocation.error),
});

/**
 * Support for FF's operators: finding what a customer asks about, and a
 * function's page. What the customer's users sent and got back, the code and
 * the logs are the customer's data: an operator sees them only by giving a
 * reason, and each look is recorded in the customer's own audit log, where it
 * shows as FF's, with that reason, so that customers can see when FF looked.
 */
@Injectable()
export class AdminSupportService {
  constructor(
    @InjectRepository(Function) private readonly functions: Repository<Function>,
    @InjectRepository(FunctionInvocation) private readonly invocations: Repository<FunctionInvocation>,
    private readonly accounts: AdminAccountsService,
    private readonly functionsService: FunctionsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * One text, looked for as an account (its ID, its name, a member's e-mail),
   * a function (its ID, or a part of its name) and a call (its request ID). A
   * call the history no longer keeps is still found by its usage record.
   */
  async search(text: string): Promise<AdminSearchView> {
    const q = text.trim();
    const { accounts } = await this.accounts.list({ q }, { limit: 10 });
    const isId = UUID.test(q);
    const rows = await this.functions.manager.query<Array<{ id: string; name: string; runtime: string; status: string; account_id: string; account_name: string }>>(
      `SELECT f."id", f."name", f."runtime", f."status", f."account_id", a."name" AS "account_name"
         FROM "functions" f JOIN "accounts" a ON a."id" = f."account_id"
        WHERE ${isId ? 'f."id" = $1::uuid' : `f."name" ILIKE $1 ESCAPE '\\'`}
        ORDER BY f."created_at" DESC LIMIT 20`,
      [isId ? q : `%${likeLiteral(q)}%`],
    );
    const functions: AdminFunctionHitView[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      runtime: row.runtime,
      status: row.status,
      accountId: row.account_id,
      accountName: row.account_name,
    }));
    return { accounts, functions, calls: isId ? await this.callsByRequestId(q.toLowerCase()) : [] };
  }

  private async callsByRequestId(requestId: string): Promise<AdminCallHitView[]> {
    const kept = await this.invocations.findOne({ where: { id: requestId }, relations: { function: true } });
    if (kept) {
      return [
        {
          requestId,
          functionId: kept.functionId,
          functionName: kept.function.name,
          accountId: kept.function.accountId,
          status: kept.status,
          at: kept.createdAt,
          inHistory: true,
          functionExists: true,
        },
      ];
    }
    const records = await this.functions.manager.query<
      Array<{ function_id: string; function_name: string; account_id: string; status: string; started_at: Date; function_exists: boolean }>
    >(
      `SELECT u."function_id", u."function_name", u."account_id", u."status", u."started_at",
              EXISTS (SELECT 1 FROM "functions" f WHERE f."id" = u."function_id") AS "function_exists"
         FROM "usage_records" u WHERE u."request_id" = $1`,
      [requestId],
    );
    return records.map((row) => ({
      requestId,
      functionId: row.function_id,
      functionName: row.function_name,
      accountId: row.account_id,
      status: AS_INVOCATION_STATUS[row.status] ?? InvocationStatus.ERROR,
      at: row.started_at,
      inHistory: false,
      functionExists: row.function_exists,
    }));
  }

  /** A function's page: its settings and state, its account, and its recent calls and failures, without their data. */
  async functionPage(id: string): Promise<AdminFunctionPageView> {
    const fn = await this.findFunction(id);
    const [recent, failed] = await Promise.all([
      this.invocations.find({ where: { functionId: id }, order: { createdAt: 'DESC' }, take: 20 }),
      this.invocations.find({ where: { functionId: id, status: In(FAILED) }, order: { createdAt: 'DESC' }, take: 10 }),
    ]);
    const { name, runtime, memory, timeout, minInstances, maxInstances, status, createdAt, updatedAt } = fn;
    return {
      function: { id, name, runtime, memory, timeout, minInstances, maxInstances, status, error: fn.error ?? null, createdAt, updatedAt },
      account: await this.accounts.summaryOf(fn.accountId),
      recentCalls: recent.map(callView),
      recentErrors: failed.map(callView),
    };
  }

  /** The function's code, for a reason that goes to the customer's audit log. */
  async viewCode(id: string, reason: string): Promise<AdminCodeView> {
    const fn = await this.findFunction(id);
    await this.recordLook({ accountId: fn.accountId, action: 'support.view_code', resource: `function:${id}`, details: { reason } });
    return { runtime: fn.runtime, code: fn.code };
  }

  /** One call's input, output and error, as the history keeps them, for a reason that goes to the customer's audit log. */
  async viewCall(functionId: string, invocationId: string, reason: string): Promise<AdminCallDataView> {
    const fn = await this.findFunction(functionId);
    const call = await this.invocations.findOne({ where: { id: invocationId, functionId, status: Not(InvocationStatus.RUNNING) } });
    if (!call) throw new NotFoundException(`The history has no call ${invocationId} of function ${functionId}`);
    await this.recordLook({
      accountId: fn.accountId,
      action: 'support.view_invocation',
      resource: `invocation:${invocationId}`,
      details: { reason, functionId },
    });
    return {
      ...callView(call),
      input: call.input,
      output: call.output,
      error: call.error ?? null,
      inputTruncated: call.inputTruncated,
      outputTruncated: call.outputTruncated,
      errorTruncated: call.errorTruncated,
    };
  }

  /**
   * A page of the function's log lines, as its account reads them (within its
   * plan's retention), for a reason that goes to the customer's audit log,
   * with what was asked for: each page is a look.
   */
  async viewLogs(id: string, reason: string, request: FunctionLogsQuery): Promise<FunctionLogsView> {
    const fn = await this.findFunction(id);
    const asked = Object.fromEntries(Object.entries({ q: request.q, requestId: request.requestId, start: request.start, end: request.end, sinceSeconds: request.sinceSeconds }).filter(([, v]) => v !== undefined));
    await this.recordLook({ accountId: fn.accountId, action: 'support.view_logs', resource: `function:${id}`, details: { reason, ...asked } });
    return this.functionsService.logs(fn.accountId, id, request);
  }

  /**
   * Records a look in the customer's audit log, or fails it: written through
   * the entity manager, an entry that can't be written throws, so no data is
   * given without its record (a change's entry, written apart, is only logged).
   */
  private recordLook(event: AuditEvent): Promise<void> {
    return this.audit.record(event, this.functions.manager);
  }

  private async findFunction(id: string): Promise<Function> {
    const fn = await this.functions.findOne({ where: { id } });
    if (!fn) throw new NotFoundException(`Function ${id} not found`);
    return fn;
  }
}
