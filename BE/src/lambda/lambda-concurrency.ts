import { Injectable } from '@nestjs/common';
import { DEFAULT_MAX_INSTANCES, Function } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { invalidParameterValue } from './lambda-error';
import { refuseUnknownFields, said } from './lambda-fields';
import { LambdaAnswer, LambdaCall, LambdaCaller, LambdaHandler, LambdaHandlers, ok, unqualifiedFunction } from './lambda-operations';

const TAKEN = new Set(['ReservedConcurrentExecutions']);

/**
 * The function's reserved concurrency, as Lambda's: 0 while its calls are stopped, else its most instances, each of
 * which serves one call at a time; none at FF's default, so that a tool's default sees nothing to change.
 */
export function reservedConcurrency(function_: Pick<Function, 'maxInstances' | 'callsStopped'>): number | undefined {
  if (function_.callsStopped) return 0;
  return function_.maxInstances === DEFAULT_MAX_INSTANCES ? undefined : function_.maxInstances;
}

/** Lambda's answer of a reservation: its number, or nothing for none. */
const reservation = (reserved: number | undefined) => (reserved === undefined ? {} : { ReservedConcurrentExecutions: reserved });

/**
 * Lambda's reserved concurrency over FF's instances (ADR 0014): PutFunctionConcurrency, GetFunctionConcurrency and
 * DeleteFunctionConcurrency, each naming the function alone. A reservation is the most instances the function runs,
 * within the plan's and no fewer than those it keeps running; 0 stops every call, its versions' and aliases' too;
 * none puts back FF's default.
 */
@Injectable()
export class LambdaConcurrency implements LambdaHandlers {
  constructor(private readonly functions: FunctionsService) {}

  readonly handlers: Record<string, LambdaHandler> = {
    PutFunctionConcurrency: (call, caller) => this.put(call, caller),
    GetFunctionConcurrency: ({ operation }, caller) => Promise.resolve(ok(reservation(reservedConcurrency(unqualifiedFunction(caller, operation.name))))),
    DeleteFunctionConcurrency: async ({ operation }, caller) => {
      const function_ = unqualifiedFunction(caller, operation.name);
      // No fewer than the instances it keeps running, which may be more than FF's default.
      await this.functions.reserveConcurrency(caller.accountId, function_.id, { maxInstances: Math.max(DEFAULT_MAX_INSTANCES, function_.minInstances), callsStopped: false });
      return { status: 204 };
    },
  };

  private async put({ input, operation }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = unqualifiedFunction(caller, operation.name);
    refuseUnknownFields(input, operation.name, TAKEN);
    const reserved = this.reservedOf(input.ReservedConcurrentExecutions, function_, caller);
    // 0 keeps the most instances it had, for when its calls start again.
    await this.functions.reserveConcurrency(caller.accountId, function_.id, { maxInstances: reserved === 0 ? function_.maxInstances : reserved, callsStopped: reserved === 0 });
    return ok({ ReservedConcurrentExecutions: reserved });
  }

  /** ReservedConcurrentExecutions, a whole number: within the plan's instances, and no fewer than those the function keeps running. */
  private reservedOf(sent: unknown, function_: Function, { plan }: LambdaCaller): number {
    if (typeof sent !== 'number' || !Number.isInteger(sent) || sent < 0) {
      throw invalidParameterValue(`ReservedConcurrentExecutions must be a whole number of calls at once, 0 or more, not ${said(sent)}.`);
    }
    const most = plan.limits.instancesPerFunction;
    if (sent > most) throw invalidParameterValue(`ReservedConcurrentExecutions must be at most ${most} on the ${plan.name} plan: each of a function's instances serves one call at a time.`);
    if (sent < function_.minInstances) {
      throw invalidParameterValue(
        `ReservedConcurrentExecutions must be at least ${function_.minInstances}, the instances the function keeps running, as Lambda's provisioned concurrency must fit within it.`,
      );
    }
    return sent;
  }
}
