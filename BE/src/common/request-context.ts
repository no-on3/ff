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

/** Who makes a request, as the audit log names them (P-17). */
export interface Actor {
  /** user:<id>, key:<id>, operator:<id>, dev, or system. */
  id: string;
  /** The user's e-mail, or the key's name. */
  label: string;
}

/** What the global guard leaves on a request: the caller. */
interface WithCaller extends WithRequestId {
  principal?: { keyId?: string; keyName?: string; userId?: string };
  user?: { id: string; email: string };
  /** An operator, on the admin dashboard's routes (P-70). */
  operator?: { id: string; email: string };
  ip?: string;
}

/** The request being served: its ID, and once the guard has run, its caller and address. */
export interface RequestContext {
  requestId: string;
  actor?: Actor;
  ip?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The ID of the request being served; undefined outside one (timers, startup). */
export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** The request being served; undefined outside one. */
export function currentRequest(): RequestContext | undefined {
  return storage.getStore();
}

/** Runs `work` as part of a request with this context, as the interceptor does: for tests, and work done for someone. */
export function withRequestContext<T>(context: RequestContext, work: () => T): T {
  return storage.run(context, work);
}

/** The caller of a request, as the audit log names them: an operator, an API key, a user, or development mode. */
export function actorOf(request: WithCaller): Actor | undefined {
  const { principal, user, operator } = request;
  if (operator) return { id: `operator:${operator.id}`, label: operator.email };
  if (principal?.keyId) return { id: `key:${principal.keyId}`, label: `API key "${principal.keyName ?? principal.keyId}"` };
  if (user) return { id: `user:${user.id}`, label: user.email };
  if (principal?.userId === 'dev') return { id: 'dev', label: 'development mode' };
  return undefined;
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
    const request = http.getRequest<WithCaller>();
    const requestId = requestIdOf(request);
    http.getResponse<{ setHeader(name: string, value: string): void }>().setHeader(REQUEST_ID_HEADER, requestId);
    // Interceptors run after the guards, so the caller is known (P-17).
    const store: RequestContext = { requestId, actor: actorOf(request), ip: request.ip };
    // Subscribing inside the context lets the handler's asynchronous work see it.
    return new Observable((subscriber) => storage.run(store, () => next.handle().subscribe(subscriber)));
  }
}
