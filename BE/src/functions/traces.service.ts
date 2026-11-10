import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { TraceCallView, TraceView } from './dto/trace.dto';
import { FunctionInvocation } from './entities/function-invocation.entity';
import { isTraceId, traceRoot } from './trace';

/** The most calls a trace's answer holds: its first ones, in time order. */
export const TRACE_CALLS = 1000;

/**
 * One request's trail: the calls of the account that share a trace, in time
 * order, found by the trace's index. A trace's ID is its caller's to choose, so
 * two accounts' calls may share one: each reads its own alone. Kept as long as
 * the history, which a function's deletion takes along.
 */
@Injectable()
export class TracesService {
  constructor(@InjectRepository(FunctionInvocation) private readonly invocations: Repository<FunctionInvocation>) {}

  /** The trace `id` names: its ID, or a header naming it (`Root=1-…`). 400 for neither, 404 when no call of the account has it. */
  async get(accountId: string, id: string): Promise<TraceView> {
    const traceId = isTraceId(id.toLowerCase()) ? id.toLowerCase() : traceRoot(id);
    if (!traceId) {
      throw new BadRequestException(`"${id}" is no trace ID: one is 1-, the time in 8 hex digits, -, then 24 hex digits, as AWS X-Ray writes it`);
    }
    const found = await this.invocations
      .createQueryBuilder('invocation')
      .innerJoin('invocation.function', 'fn')
      .select(['invocation.id', 'invocation.requestId', 'invocation.attempt', 'invocation.functionId', 'invocation.source', 'invocation.trigger', 'invocation.version', 'invocation.alias'])
      .addSelect(['invocation.status', 'invocation.duration', 'invocation.createdAt', 'fn.id', 'fn.name'])
      .where('invocation.traceId = :traceId AND fn.accountId = :accountId', { traceId, accountId })
      .orderBy('invocation.createdAt', 'ASC')
      .addOrderBy('invocation.attempt', 'ASC')
      .limit(TRACE_CALLS + 1)
      .getMany();
    if (found.length === 0) throw new NotFoundException(`The account has no call in trace ${traceId}`);
    return { traceId, calls: found.slice(0, TRACE_CALLS).map(callView), truncated: found.length > TRACE_CALLS };
  }
}

/** A call as a trace shows it. */
function callView(call: FunctionInvocation): TraceCallView {
  const { id, requestId, attempt, functionId, source, trigger, version, alias, status, duration, createdAt } = call;
  return { id, requestId, attempt, functionId, functionName: call.function.name, source, trigger, version, alias, status, duration, createdAt };
}
