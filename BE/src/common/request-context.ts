import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';

/**
 * Every answer carries its request's ID, and the server log names it with any
 * failure, so the details of an error that the caller only sees as generic can
 * be found (D4).
 */
export const REQUEST_ID_HEADER = 'x-ff-request-id';

interface WithRequestId {
  requestId?: string;
}

const storage = new AsyncLocalStorage<{ requestId: string }>();

/** The ID of the request being served; undefined outside one (timers, startup). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** The request's ID, given to it on first use. */
export function requestIdOf(request: WithRequestId): string {
  return (request.requestId ??= randomUUID());
}

/** Gives each request its ID: in the answer's header, and to the code that serves it. */
@Injectable()
export class RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const requestId = requestIdOf(http.getRequest<WithRequestId>());
    http.getResponse<{ setHeader(name: string, value: string): void }>().setHeader(REQUEST_ID_HEADER, requestId);
    // Subscribing inside the context lets the handler's asynchronous work see it.
    return new Observable((subscriber) => storage.run({ requestId }, () => next.handle().subscribe(subscriber)));
  }
}
