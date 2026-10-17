import { BadRequestException, createParamDecorator, ExecutionContext, UnauthorizedException } from '@nestjs/common';

/** An account ID: 12 random digits, the AWS-shaped format of ADR 0004. */
export const ACCOUNT_ID = /^\d{12}$/;

/** In development mode only: act as another account, to test isolation (ADR 0004). */
export const DEV_ACCOUNT_HEADER = 'x-ff-dev-account';

export type Role = 'owner' | 'developer' | 'viewer';

/** Who is calling, and on behalf of which account (D4). */
export interface Principal {
  accountId: string;
  /** The user acting, when a token is used. */
  userId?: string;
  /** The API key acting, when one is used (D3). */
  keyId?: string;
  role: Role;
  /** What an API key may do. A user's token may do all that its role allows. */
  scopes?: string[];
}

interface RequestWithPrincipal {
  principal?: Principal;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The caller. The global guard (P-11) sets request.principal from a token or
 * an API key. In development mode, without one, the caller is the owner of
 * FF_DEV_ACCOUNT_ID, or of the account that X-FF-Dev-Account names. Anyone
 * else gets 401.
 */
export function resolvePrincipal(request: RequestWithPrincipal, devAccountId: string | undefined): Principal {
  if (request.principal) return request.principal;
  if (!devAccountId) throw new UnauthorizedException('Authentication required');
  const named = request.headers[DEV_ACCOUNT_HEADER];
  if (named === undefined) return { accountId: devAccountId, userId: 'dev', role: 'owner' };
  if (typeof named !== 'string' || !ACCOUNT_ID.test(named)) {
    throw new BadRequestException('X-FF-Dev-Account must be an account ID: 12 digits');
  }
  return { accountId: named, userId: 'dev', role: 'owner' };
}

/**
 * FF_DEV_ACCOUNT_ID when FF_AUTH_MODE=dev, else nothing. Both are checked at
 * boot (src/config/configuration.ts), and production refuses the development mode.
 */
export function devAccountId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.FF_AUTH_MODE?.trim() === 'dev' ? env.FF_DEV_ACCOUNT_ID?.trim() || undefined : undefined;
}

/** The caller, in a route handler: `@Principal() principal: Principal`. */
export const Principal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal =>
  resolvePrincipal(ctx.switchToHttp().getRequest<RequestWithPrincipal>(), devAccountId()),
);
