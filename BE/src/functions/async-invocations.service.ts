import { BadRequestException, HttpException, HttpStatus, Injectable, PayloadTooLargeException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CreditService } from '../billing/credit.service';
import { jsonBytes } from '../common/byte-limits';
import { currentRequestId } from '../common/request-context';
import { PlansService } from '../plans/plans.service';
import { QueueStore } from '../queues/queue-store';
import { EXPIRY_GRACE_SECONDS, LAMBDA_RETRY_POLICY, MAX_ASYNC_INPUT_BYTES } from './async-invoke';
import { FunctionStatus } from './entities/function.entity';
import { FunctionsService } from './functions.service';
import { MAX_INPUT_BYTES } from './limits';

/** A megabyte, as the plans count what messages hold. */
const MB = 1024 * 1024;

/** As AWS Lambda refuses an event over its limit, with its words and its exception's name. */
function refuseOver(limit: number, size: number): void {
  if (size <= limit) return;
  throw new PayloadTooLargeException({
    statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
    error: 'RequestEntityTooLargeException',
    message: `Request must be smaller than ${limit} bytes for the InvokeFunction operation: the input is ${size} bytes as JSON`,
  });
}

/**
 * The API's invoke with the invocation types Event and DryRun, as AWS
 * Lambda's (ADR 0010). An Event is checked as a call is (the function, its
 * input's size, the account's credit, the plan's rate, which the route
 * counts), then kept in the function's queue, and answered at once with its
 * request ID; FF's worker runs it (AsyncInvokeWorker).
 */
@Injectable()
export class AsyncInvocationsService {
  constructor(
    private readonly functions: FunctionsService,
    private readonly credit: CreditService,
    private readonly plans: PlansService,
    private readonly queues: QueueStore,
  ) {}

  /**
   * Keeps the call for the worker, and answers its request ID: the request's
   * own, which the answer's x-ff-request-id names too, and which every attempt
   * keeps. The account's messages may hold the plan's queueStorageMb together,
   * this event included; past it, 429 until some are handled. A refused call
   * keeps nothing.
   */
  async queue(accountId: string, id: string, input?: unknown): Promise<{ requestId: string }> {
    const body = JSON.stringify(input === undefined ? {} : input);
    const size = Buffer.byteLength(body);
    refuseOver(MAX_ASYNC_INPUT_BYTES, size);
    const function_ = await this.functions.findOne(accountId, id);
    if (function_.status !== FunctionStatus.ACTIVE) throw new BadRequestException('Function is not active');
    await this.credit.admit(accountId);
    const plan = await this.plans.forAccount(accountId);
    // Read before the write: calls at once may pass the limit by their own sizes, which the next ones see.
    if ((await this.queues.accountBytes(accountId)) + size > plan.limits.queueStorageMb * MB) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message:
            `TooManyRequestsException: the account's messages hold ${plan.limits.queueStorageMb} MB together, the ${plan.name} plan's limit, ` +
            'its asynchronous calls waiting to run among them: this call was not kept. Try again once they are handled.',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const requestId = currentRequestId() ?? randomUUID();
    const expiresAt = new Date(Date.now() + (LAMBDA_RETRY_POLICY.maximumEventAgeSeconds + EXPIRY_GRACE_SECONDS) * 1000);
    await this.queues.sendEvent(function_, requestId, body, expiresAt);
    return { requestId };
  }

  /** The invocation type DryRun, as Lambda's: the function is the account's, and the input could be sent; nothing runs. */
  async dryRun(accountId: string, id: string, input?: unknown): Promise<void> {
    refuseOver(MAX_INPUT_BYTES, jsonBytes(input === undefined ? {} : input));
    await this.functions.findOne(accountId, id);
  }
}
