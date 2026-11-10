import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Principal } from '../auth/principal';
import { RequireScope } from '../auth/route-rules';
import { TraceView } from './dto/trace.dto';
import { TracesService } from './traces.service';

/** One request's trail across the account's functions: every member reads it, as they read the logs. */
@ApiTags('traces')
@Controller('traces')
export class TracesController {
  constructor(private readonly traces: TracesService) {}

  @Get(':id')
  @RequireScope('logs:read')
  @ApiOperation({
    summary: "One request's trail: the account's calls in a trace, oldest first",
    description:
      "A trace's ID is in AWS X-Ray's format (1-<time>-<random>), as Lambda gives a call its _X_AMZN_TRACE_ID; a header naming it (Root=1-…) " +
      "does too. A call takes its trace from its caller's X-Amzn-Trace-Id, from FF's API, Lambda's or its URL, or from the AWSTraceHeader of " +
      "the queue's message it reads; a schedule's run and a bucket's notification start one. An asynchronous call's attempts and its destination's " +
      'record keep it. Each call says how it came, its function, version, status and duration; the first 1000 are given.',
  })
  @ApiResponse({ status: 200, type: TraceView })
  @ApiResponse({ status: 400, description: "Not a trace ID in X-Ray's format" })
  @ApiResponse({ status: 404, description: 'No call of the account has this trace' })
  get(@Param('id') id: string, @Principal() principal: Principal): Promise<TraceView> {
    return this.traces.get(principal.accountId, id);
  }
}
