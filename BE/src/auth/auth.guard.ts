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
import { MembersService } from '../accounts/members.service';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { AccountStatus } from '../accounts/entities/account.entity';
import { User } from '../accounts/entities/user.entity';
import { ACCOUNT_HEADER, ACCOUNT_ID, DEV_ACCOUNT_HEADER, RequestWithPrincipal, resolvePrincipal, Role } from './principal';
import { requestIdOf } from '../common/request-context';
import { IS_PUBLIC } from './public.decorator';
import { ACTIVE_ACCOUNT, ANY_KEY, ROLES, SCOPE } from './route-rules';
import { Identity, InvalidTokenError, TokenVerifier, UnverifiedEmailError } from './token-verifier';
import { ADMIN_CLIENT, CHANGES_NOTHING, IS_ADMIN, OPERATOR_ROLE, REASON_LENGTH, RequestWithOperator, reasonOf } from '../admin/operator';

type GuardedRequest = RequestWithPrincipal &
  RequestWithOperator & { user?: User; ip?: string; requestId?: string; method?: string; body?: unknown };

/** What only reads: every other method changes something, and on an admin route needs a reason. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

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
 *   A token's user is found, or created on the first call, joins the accounts
 *   that invited its address (P-16), and the account is chosen from the user's
 *   memberships and X-FF-Account (P-12); when that fails, @Principal() says
 *   why. A key acts for its own account.
 * Then the route's rules apply: who may call it (@RequireRole), whether the
 * account must be active (@RequireActiveAccount), and for a key, the scope it
 * needs (@RequireScope); a route without one takes no key, unless any key may
 * call it (@AllowAnyApiKey).
 *
 * The admin dashboard's routes (@AdminRoutes(), P-70) are apart: an operator's
 * token issued to ff-admin, never a key or development mode, and a reason for
 * every change. A token issued to ff-admin calls no customer route (D12).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly accounts: AccountsService,
    private readonly members: MembersService,
    private readonly apiKeys: ApiKeysService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    if (this.reflector.getAllAndOverride<boolean>(IS_ADMIN, targets)) {
      await this.authenticateOperator(request, this.reflector.getAllAndOverride<boolean>(CHANGES_NOTHING, targets) === true);
      return true;
    }
    if (this.config.get<string>('auth.mode') === 'dev') {
      await this.actAsDevelopmentAccount(request);
    } else {
      await this.authenticate(request);
    }

    const key = request.principal?.keyId ? request.principal : undefined;
    if (key && !this.reflector.getAllAndOverride<boolean>(ANY_KEY, targets)) {
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
    request.principal = { accountId, accountStatus: account.status, planId: account.planId, userId: 'dev', role: 'owner' };
  }

  private async authenticate(request: GuardedRequest): Promise<void> {
    const token = bearerToken(request.headers.authorization);
    if (token.startsWith('ffk_')) {
      request.principal = await this.apiKeys.authenticate(token); // 401 with the reason when it can't act
      return;
    }
    request.identity = await this.verify(token);
    if (request.identity.clientId === ADMIN_CLIENT) {
      throw new ForbiddenException("This token was issued to the admin dashboard: the customer routes take the console's");
    }
    request.user = await this.accounts.userFor(request.identity);
    // The accounts that invited the user's address (P-16), recorded before the request context exists (P-17).
    await this.members.acceptInvitations(request.user, new Date(), { ip: request.ip, requestId: requestIdOf(request) });
    const choice = await this.accounts.choose(request.user, request.headers[ACCOUNT_HEADER]);
    if ('principal' in choice) request.principal = choice.principal;
    else request.principalProblem = choice.problem;
  }

  /**
   * An admin route (P-70, D12): an operator's token, issued to the admin
   * dashboard; never an API key or development mode. A change needs a reason,
   * which the audit log keeps with it; asked for only once the caller is known.
   */
  private async authenticateOperator(request: GuardedRequest, changesNothing: boolean): Promise<void> {
    if (this.config.get<string>('auth.mode') === 'dev') {
      throw new BadRequestException("Development mode has no operator: the admin dashboard needs FF_AUTH_MODE=oidc and an operator's login");
    }
    const token = bearerToken(request.headers.authorization);
    if (token.startsWith('ffk_')) throw new ForbiddenException("API keys can't call the admin routes");
    const identity = await this.verify(token);
    if (identity.clientId !== ADMIN_CLIENT) {
      throw new ForbiddenException(`The admin routes take a token issued to the admin dashboard (${ADMIN_CLIENT})`);
    }
    if (!identity.realmRoles?.includes(OPERATOR_ROLE)) throw new ForbiddenException("The admin routes are for FF's operators");
    request.operator = { id: identity.userId, email: identity.email ?? identity.userId, ...(identity.name ? { name: identity.name } : {}) };
    if (!changesNothing && !READS.has(request.method ?? 'GET') && !reasonOf(request)) {
      // A file for a body, such as a withholding certificate (P-35), has its reason in a header.
      const where = Buffer.isBuffer(request.body) ? 'in the X-FF-Reason header, URI-encoded: the body is the file' : 'in the body';
      throw new BadRequestException(`Every admin change needs a reason: send reason, ${REASON_LENGTH.min} to ${REASON_LENGTH.max} characters, ${where}`);
    }
  }

  /** A token from the realm: 401 when it can't be trusted, 403 for an unverified e-mail address. */
  private async verify(token: string): Promise<Identity> {
    try {
      return await this.verifier.verify(token);
    } catch (error) {
      if (error instanceof InvalidTokenError) throw new UnauthorizedException(error.message);
      if (error instanceof UnverifiedEmailError) throw new ForbiddenException(error.message);
      throw error; // the realm's keys couldn't be read: a platform failure
    }
  }
}
