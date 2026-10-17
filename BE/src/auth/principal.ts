import { createParamDecorator, ExecutionContext, HttpException, UnauthorizedException } from '@nestjs/common';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Identity } from './token-verifier';

/** An account ID: 12 random digits, the AWS-shaped format of ADR 0004. */
export const ACCOUNT_ID = /^\d{12}$/;

/** In development mode only: act as another account, to test isolation (ADR 0004). */
export const DEV_ACCOUNT_HEADER = 'x-ff-dev-account';

/** Which of the user's accounts a request acts for, when the user has several (D4). */
export const ACCOUNT_HEADER = 'x-ff-account';

export type Role = 'owner' | 'developer' | 'viewer';

/** Who is calling, and on behalf of which account (D4). */
export interface Principal {
  accountId: string;
  /** Only an active account deploys and invokes: a new one waits for approval (P-12). */
  accountStatus: AccountStatus;
  /** The user acting, when a token is used ("dev" in development mode). */
  userId?: string;
  /** The API key acting, when one is used (D3). */
  keyId?: string;
  role: Role;
  /** What an API key may do. A user's token may do all that its role allows. */
  scopes?: string[];
}

export interface RequestWithPrincipal {
  principal?: Principal;
  /** Why there is no principal: a user without an account, or who must choose one (P-12). */
  principalProblem?: HttpException;
  /** The user of a valid token, set by the global guard (P-11). */
  identity?: Identity;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The caller of a route that acts for an account. The global guard resolves it
 * (AuthGuard): from development mode's account, or from the user's memberships
 * and X-FF-Account. When it couldn't, the guard recorded why, and that is the
 * answer: 403 for a user without an account, 400 for one who must name one,
 * 404 for an account the user isn't a member of. Anyone else gets 401.
 */
export function resolvePrincipal(request: RequestWithPrincipal): Principal {
  if (request.principal) return request.principal;
  if (request.principalProblem) throw request.principalProblem;
  throw new UnauthorizedException('Authentication required');
}

/** The caller, in a route handler: `@Principal() principal: Principal`. */
export const Principal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal =>
  resolvePrincipal(ctx.switchToHttp().getRequest<RequestWithPrincipal>()),
);
