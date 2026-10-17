import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AccountsService } from '../accounts/accounts.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { AccountStatus } from '../accounts/entities/account.entity';
import { User } from '../accounts/entities/user.entity';
import { ACCOUNT_HEADER, ACCOUNT_ID, DEV_ACCOUNT_HEADER, RequestWithPrincipal, resolvePrincipal, Role } from './principal';
import { IS_PUBLIC } from './public.decorator';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from './route-rules';
import { InvalidTokenError, TokenVerifier, UnverifiedEmailError } from './token-verifier';

type GuardedRequest = RequestWithPrincipal & { user?: User };

/** The token of an `Authorization: Bearer <token>` header. */
export function bearerToken(header: string | string[] | undefined): string {
  if (header === undefined) throw new UnauthorizedException('Authentication required');
  const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  if (!match) throw new UnauthorizedException('Authentication required: send "Authorization: Bearer <token>"');
  return match[1];
}

const STATUS_MESSAGES: Record<Exclude<AccountStatus, AccountStatus.ACTIVE>, string> = {
  [AccountStatus.PENDING]: 'Your account is waiting for approval: you can deploy and invoke functions once it is approved',
  [AccountStatus.REJECTED]: 'Your account was not approved',
  [AccountStatus.SUSPENDED]: 'Your account is suspended',
  [AccountStatus.CLOSED]: 'Your account is closed',
};

/**
 * The global guard (D4): it denies by default.
 * - A @Public() route passes.
 * - Development mode acts as the owner of FF_DEV_ACCOUNT_ID, or of the account
 *   that X-FF-Dev-Account names, created the first time.
 * - Otherwise the request needs a valid access token (P-11) or API key (P-13).
 *   A token's user is found, or created on the first call, and the account
 *   chosen from the user's memberships and X-FF-Account (P-12); when that
 *   fails, @Principal() says why. A key acts for its own account.
 * Then the route's rules apply: who may call it (@RequireRole), whether the
 * account must be active (@RequireActiveAccount), and for a key, the scope it
 * needs (@RequireScope); a route without one takes no key.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly accounts: AccountsService,
    private readonly apiKeys: ApiKeysService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    if (this.config.get<string>('auth.mode') === 'dev') {
      await this.actAsDevelopmentAccount(request);
    } else {
      await this.authenticate(request);
    }

    const key = request.principal?.keyId ? request.principal : undefined;
    if (key) {
      const scope = this.reflector.getAllAndOverride<string | undefined>(SCOPE, targets);
      if (!scope) throw new ForbiddenException("API keys can't call this route: it takes a user's token");
      if (!key.scopes?.includes(scope)) throw new ForbiddenException(`This API key lacks the scope ${scope}`);
    }

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    const mustBeActive = this.reflector.getAllAndOverride<boolean | undefined>(ACTIVE_ACCOUNT, targets);
    if (roles || mustBeActive) {
      const principal = resolvePrincipal(request);
      if (roles && !roles.includes(principal.role)) throw new ForbiddenException(`The ${principal.role} role can't do this`);
      if (mustBeActive && principal.accountStatus !== AccountStatus.ACTIVE) {
        throw new ForbiddenException(STATUS_MESSAGES[principal.accountStatus]);
      }
    }
    return true;
  }

  private async actAsDevelopmentAccount(request: GuardedRequest): Promise<void> {
    const named = request.headers[DEV_ACCOUNT_HEADER];
    if (named !== undefined && (typeof named !== 'string' || !ACCOUNT_ID.test(named))) {
      throw new BadRequestException('X-FF-Dev-Account must be an account ID: 12 digits');
    }
    const accountId = named ?? this.config.getOrThrow<string>('auth.devAccountId');
    const account = await this.accounts.developmentAccount(accountId);
    request.principal = { accountId, accountStatus: account.status, userId: 'dev', role: 'owner' };
  }

  private async authenticate(request: GuardedRequest): Promise<void> {
    const token = bearerToken(request.headers.authorization);
    if (token.startsWith('ffk_')) {
      request.principal = await this.apiKeys.authenticate(token); // 401 with the reason when it can't act
      return;
    }
    try {
      request.identity = await this.verifier.verify(token);
    } catch (error) {
      if (error instanceof InvalidTokenError) throw new UnauthorizedException(error.message);
      if (error instanceof UnverifiedEmailError) throw new ForbiddenException(error.message);
      throw error; // the realm's keys couldn't be read: a platform failure
    }
    request.user = await this.accounts.userFor(request.identity);
    const choice = await this.accounts.choose(request.user, request.headers[ACCOUNT_HEADER]);
    if ('principal' in choice) request.principal = choice.principal;
    else request.principalProblem = choice.problem;
  }
}
