import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

/**
 * The caller's tenant ID, until P-10 replaces this decorator with @Principal():
 * the authenticated user's `sub` on request.user (set by the authentication
 * guard that P-11 adds), or, in development mode, the development account.
 * Without either, the request is rejected.
 */
export function resolveTenantId(user: unknown, devAccountId: string | undefined): string {
  if (typeof user === 'string' && user) return user;
  if (user && typeof user === 'object' && 'sub' in user) {
    // A subject is a string (or a number); anything else would become "[object Object]".
    if ((typeof user.sub === 'string' && user.sub) || typeof user.sub === 'number') return String(user.sub);
  }
  if (devAccountId) return devAccountId;
  throw new UnauthorizedException('Authentication required');
}

/**
 * FF_DEV_ACCOUNT_ID when FF_AUTH_MODE=dev, else nothing. Both are checked at
 * boot (src/config/configuration.ts), and production refuses the dev mode.
 */
export function devAccountId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.FF_AUTH_MODE?.trim() === 'dev' ? env.FF_DEV_ACCOUNT_ID?.trim() || undefined : undefined;
}

export const User = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest<{ user?: unknown }>();
  return resolveTenantId(request.user, devAccountId());
});
