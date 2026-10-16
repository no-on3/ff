import { createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

/**
 * The caller's tenant ID: the authenticated user's `sub` on request.user (set
 * by an authentication guard, once parent plan F-01 adds one), or
 * FF_DEV_USER_ID when no authentication is in place.
 *
 * FF_DEV_USER_ID is a development-only stand-in until real authentication is
 * switched on (parent plan F-01). Without either, the request is rejected.
 */
export function resolveUserId(user: unknown, devUserId: string | undefined): string {
  if (typeof user === 'string' && user) return user;
  if (user && typeof user === 'object' && 'sub' in user && (user as { sub: unknown }).sub) {
    return String((user as { sub: unknown }).sub);
  }
  if (devUserId) return devUserId;
  throw new UnauthorizedException('Authentication required');
}

export const User = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return resolveUserId(request.user, process.env.FF_DEV_USER_ID);
});
