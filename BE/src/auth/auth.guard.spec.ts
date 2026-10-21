/**
 * L1: the global guard and the token checks (client-readiness plan, P-11, D2),
 * through a real HTTP server, with tokens signed locally and the keys served
 * by a fake OpenID issuer.
 */
import { Body, Controller, ForbiddenException, Get, INestApplication, Logger, Post, Put, Req, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { raw } from 'express';
import { exportJWK, generateKeyPair, JWK, JWTPayload, SignJWT } from 'jose';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { AccountChoice, AccountsService } from '../accounts/accounts.service';
import { MembersService } from '../accounts/members.service';
import { AccountStatus } from '../accounts/entities/account.entity';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { AdminRoutes, ChangesNothing, CurrentOperator, Operator } from '../admin/operator';
import { ApiExceptionFilter } from '../common/api-exception.filter';
import { AuthGuard } from './auth.guard';
import { Principal } from './principal';
import { Public } from './public.decorator';
import { AllowAnyApiKey, RequireActiveAccount, RequireRole, RequireScope, WRITERS } from './route-rules';
import { Identity, InvalidTokenError, TokenVerifier, UnverifiedEmailError } from './token-verifier';

const AUDIENCE = 'ff-api';

@Controller()
class ProbeController {
  @Public()
  @Get('open')
  open() {
    return { open: true };
  }

  /** What the guard recorded. */
  @Get('identity')
  identity(@Req() request: { identity?: Identity }) {
    return request.identity ?? null;
  }

  @Get('functions')
  @RequireScope('functions:read')
  functions(@Principal() principal: Principal) {
    return principal;
  }

  /** Like GET /members: a user's token only. */
  @Get('members')
  members(@Principal() principal: Principal) {
    return principal;
  }

  /** Like GET /me: a user's token, or any API key, whatever its scopes. */
  @Get('me')
  @AllowAnyApiKey()
  me(@Principal() principal: Principal) {
    return principal;
  }

  /** Like POST /functions: writers only, and an active account. */
  @Post('functions')
  @RequireScope('functions:write')
  @RequireRole(...WRITERS)
  @RequireActiveAccount()
  deploy(@Principal() principal: Principal) {
    return { deployedFor: principal.accountId };
  }
}

/** Like the admin dashboard's routes (P-70): an operator reads, and changes with a reason. */
@AdminRoutes()
@Controller('admin')
class AdminProbeController {
  @Get('settings')
  read(@CurrentOperator() operator: Operator) {
    return operator;
  }

  @Put('settings')
  change(@CurrentOperator() operator: Operator, @Body() body: { reason?: string }) {
    return { changedBy: operator.id, reason: body.reason };
  }

  /** Like a price book's preview (P-73): a POST for its body, which changes nothing. */
  @Post('settings/preview')
  @ChangesNothing()
  preview(@CurrentOperator() operator: Operator) {
    return { previewedBy: operator.id };
  }
}

/** The keys service, as the guard sees it: one valid key, which reads functions. */
const KEY = `ffk_0123456789ab_${'s'.repeat(43)}`;
const apiKeys = {
  async authenticate(value: string): Promise<Principal> {
    if (value !== KEY) throw new UnauthorizedException('The API key is invalid');
    return {
      accountId: '123456789012',
      accountStatus: AccountStatus.ACTIVE,
      planId: 'beta',
      keyId: '0123456789ab',
      userId: 'creator',
      role: 'owner',
      scopes: ['functions:read'],
    };
  },
};

/** The accounts service, as the guard sees it: what each user's request acts for. */
/** What the guard asked of the accounts and members services, in order. */
const calls: string[] = [];
const accounts = {
  choice: undefined as AccountChoice | undefined,
  developmentAccounts: [] as string[],
  developmentStatus: AccountStatus.ACTIVE,
  async userFor(identity: Identity) {
    calls.push(`userFor ${identity.userId}`);
    return { id: `user-of-${identity.userId}`, email: identity.email };
  },
  async choose() {
    calls.push('choose');
    return this.choice ?? { problem: new ForbiddenException('This user has no account yet: create one with POST /accounts') };
  },
  async developmentAccount(id: string) {
    this.developmentAccounts.push(id);
    return { id, status: this.developmentStatus, planId: 'beta' };
  },
};

type Key = Awaited<ReturnType<typeof generateKeyPair>> & { kid: string };

async function newKey(kid: string, alg = 'RS256'): Promise<Key> {
  return { ...(await generateKeyPair(alg, { extractable: true })), kid };
}

/** A fake OpenID issuer: its configuration and its keys, which a test can change. */
async function fakeIssuer() {
  const state = { keys: [] as JWK[], jwksFetches: 0, discoveries: 0, up: true };
  const server = http.createServer((req, res) => {
    if (!state.up) return void res.destroy();
    res.setHeader('content-type', 'application/json');
    if (req.url === '/realms/ff/.well-known/openid-configuration') {
      state.discoveries++;
      res.end(JSON.stringify({ issuer: `${base}/realms/ff`, jwks_uri: `${base}/realms/ff/certs` }));
    } else if (req.url === '/realms/ff/certs') {
      state.jwksFetches++;
      res.end(JSON.stringify({ keys: state.keys }));
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { issuer: `${base}/realms/ff`, state, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const publish = async (key: Key): Promise<JWK> => ({ ...(await exportJWK(key.publicKey)), kid: key.kid, alg: 'RS256', use: 'sig' });

describe('the global guard and token checks (L1, P-11)', () => {
  let issuer: Awaited<ReturnType<typeof fakeIssuer>>;
  let key: Key;
  let app: INestApplication;
  let baseUrl: string;
  let mode: 'oidc' | 'dev' = 'oidc';
  const asMember = (role: Principal['role'], accountStatus = AccountStatus.ACTIVE): AccountChoice => ({
    principal: { accountId: '123456789012', accountStatus, planId: 'beta', userId: 'user-of-kc-user-1', role },
  });

  /** A token as Keycloak would issue it, with `claims` changed. */
  async function token(claims: JWTPayload = {}, signer: Key = key, header: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({ sub: 'kc-user-1', email: 'amira@example.tn', email_verified: true, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: signer.kid, ...header })
      .setIssuer((claims.iss as string) ?? issuer.issuer)
      .setAudience((claims.aud as string) ?? AUDIENCE)
      .setIssuedAt()
      .setExpirationTime((claims.exp as number) ?? '5m')
      .sign(signer.privateKey);
  }

  const get = (path: string, authorization?: string) =>
    fetch(`${baseUrl}${path}`, { headers: authorization ? { authorization } : {} });

  /** The probe routes behind the backend's guard and filter, trusting `issuerUrl`. */
  async function startApp(issuerUrl: () => string): Promise<INestApplication> {
    const config = {
      get: (path: string) => (path === 'auth.mode' ? mode : undefined),
      getOrThrow: (path: string) => (path === 'auth.devAccountId' ? '000000000001' : { issuer: issuerUrl(), audience: AUDIENCE }),
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController, AdminProbeController],
      providers: [
        TokenVerifier,
        { provide: ConfigService, useValue: config },
        { provide: AccountsService, useValue: accounts },
        { provide: MembersService, useValue: { acceptInvitations: async (user: { id: string }) => void calls.push(`accept ${user.id}`) } },
        { provide: ApiKeysService, useValue: apiKeys },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    }).compile();
    const started = moduleRef.createNestApplication({ logger: false });
    started.use(raw({ type: 'application/pdf' })); // a file for a body, as the admin module reads a certificate (P-35)
    await started.listen(0, '127.0.0.1');
    return started;
  }

  beforeAll(async () => {
    issuer = await fakeIssuer();
    key = await newKey('key-1');
    issuer.state.keys = [await publish(key)];
    app = await startApp(() => issuer.issuer);
    baseUrl = await app.getUrl();
  });

  beforeEach(() => {
    mode = 'oidc';
    calls.length = 0;
    accounts.choice = undefined;
    accounts.developmentAccounts = [];
    accounts.developmentStatus = AccountStatus.ACTIVE;
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await issuer.close();
  });

  it("records a valid token's user on the request", async () => {
    const res = await get('/identity', `Bearer ${await token()}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'kc-user-1', email: 'amira@example.tn' });
  });

  it("lets a token's user join the accounts that invited its address, before choosing the account (P-16)", async () => {
    await get('/functions', `Bearer ${await token()}`);

    expect(calls).toEqual(['userFor kc-user-1', 'accept user-of-kc-user-1', 'choose']);
  });

  it("answers an account route with the reason the user's request can't act for an account (P-12)", async () => {
    const res = await get('/functions', `Bearer ${await token()}`);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ message: 'This user has no account yet: create one with POST /accounts' });
  });

  it("acts for the account the user's memberships give", async () => {
    accounts.choice = asMember('developer');

    const res = await get('/functions', `Bearer ${await token()}`);

    expect(await res.json()).toMatchObject({ accountId: '123456789012', role: 'developer', userId: 'user-of-kc-user-1' });
  });

  describe('API keys (P-13)', () => {
    const withKey = (path: string, method = 'GET') => fetch(`${baseUrl}${path}`, { method, headers: { authorization: `Bearer ${KEY}` } });

    it('act for their own account, with their scopes', async () => {
      const res = await withKey('/functions');

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ accountId: '123456789012', keyId: '0123456789ab', scopes: ['functions:read'] });
      expect(calls).toEqual([]); // a key has no user to join anything (P-16)
    });

    it('need the scope that the route names', async () => {
      const res = await withKey('/functions', 'POST');

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ message: 'This API key lacks the scope functions:write' });
    });

    it("can't call a route that names no scope: accounts, members and keys take a user's token", async () => {
      const res = await withKey('/members');

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ message: "API keys can't call this route: it takes a user's token" });
    });

    it('call a route open to any key whatever their scopes, as GET /me is, to say who they are', async () => {
      const res = await withKey('/me');

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ accountId: '123456789012', keyId: '0123456789ab', scopes: ['functions:read'] });
    });

    it('still need to be valid there', async () => {
      const res = await fetch(`${baseUrl}/me`, { headers: { authorization: `Bearer ffk_0123456789ab_${'a'.repeat(43)}` } });

      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ message: 'The API key is invalid' });
    });
  });

  describe("the admin dashboard's routes (P-70, D12)", () => {
    const OPERATOR = { azp: 'ff-admin', realm_access: { roles: ['ff-operator', 'offline_access'] } };
    const admin = async (claims: JWTPayload, method = 'GET', body?: unknown) =>
      fetch(`${baseUrl}/admin/settings`, {
        method,
        headers: { authorization: `Bearer ${await token(claims)}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const refusal = async (res: Response) => [res.status, ((await res.json()) as { message: string }).message];

    it("let an operator in, with a token issued to the admin dashboard, and never act for an account", async () => {
      const res = await admin(OPERATOR);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 'kc-user-1', email: 'amira@example.tn' });
      expect(calls).toEqual([]); // no user created, no invitation joined, no account chosen
    });

    it("refuse an operator's console token: only ff-admin's tokens reach them", async () => {
      expect(await refusal(await admin({ ...OPERATOR, azp: 'ff-console' }))).toEqual([
        403,
        'The admin routes take a token issued to the admin dashboard (ff-admin)',
      ]);
    });

    it("refuse a customer, with a console token or one issued to ff-admin", async () => {
      expect(await refusal(await admin({ azp: 'ff-console' }))).toEqual([403, 'The admin routes take a token issued to the admin dashboard (ff-admin)']);
      expect(await refusal(await admin({ azp: 'ff-admin' }))).toEqual([403, "The admin routes are for FF's operators"]);
      expect(await refusal(await admin({ azp: 'ff-admin', realm_access: { roles: ['ff-operators'] } }))).toEqual([
        403,
        "The admin routes are for FF's operators",
      ]);
    });

    it('refuse API keys, development mode, and callers without a valid token', async () => {
      const withKey = await fetch(`${baseUrl}/admin/settings`, { headers: { authorization: `Bearer ${KEY}` } });
      expect(await refusal(withKey)).toEqual([403, "API keys can't call the admin routes"]);
      expect((await get('/admin/settings')).status).toBe(401);
      expect((await get('/admin/settings', `Bearer ${(await token(OPERATOR)).slice(0, -4)}AAAA`)).status).toBe(401);
      expect(await refusal(await admin({ ...OPERATOR, email_verified: false }))).toEqual([403, 'Verify your e-mail address first']);

      mode = 'dev';
      expect(await refusal(await get('/admin/settings'))).toEqual([
        400,
        "Development mode has no operator: the admin dashboard needs FF_AUTH_MODE=oidc and an operator's login",
      ]);
      expect(accounts.developmentAccounts).toEqual([]);
    });

    it('take a reason with every change, asked for only once the operator is known', async () => {
      const missing = 'Every admin change needs a reason: send reason, 3 to 500 characters, in the body';
      expect(await refusal(await admin(OPERATOR, 'PUT', {}))).toEqual([400, missing]);
      expect(await refusal(await admin(OPERATOR, 'PUT', { reason: ' ok ' }))).toEqual([400, missing]);
      expect(await refusal(await admin(OPERATOR, 'PUT', { reason: 7 }))).toEqual([400, missing]);
      expect(await refusal(await admin(OPERATOR, 'PUT', { reason: 'x'.repeat(501) }))).toEqual([400, missing]);
      expect((await admin({ azp: 'ff-admin' }, 'PUT', {})).status).toBe(403); // a customer learns nothing of the rule

      const res = await admin(OPERATOR, 'PUT', { reason: 'Pilot customers asked for it' });
      expect([res.status, await res.json()]).toEqual([200, { changedBy: 'kc-user-1', reason: 'Pilot customers asked for it' }]);
    });

    it("take a file's reason from the X-FF-Reason header, URI-encoded, when the body is the file (P-35)", async () => {
      const withHeader = async (reason: string) =>
        fetch(`${baseUrl}/admin/settings`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${await token(OPERATOR)}`, 'content-type': 'application/json', 'x-ff-reason': reason },
          body: '{}',
        });

      expect((await withHeader(encodeURIComponent('Certificat reçu par e-mail'))).status).toBe(200);
      const missing = 'Every admin change needs a reason: send reason, 3 to 500 characters, in the body';
      expect(await refusal(await withHeader('%E0%A4%A'))).toEqual([400, missing]); // not URI-encoded
      expect(await refusal(await withHeader('ok'))).toEqual([400, missing]);

      // The body a file: the refusal says where its reason goes.
      const file = async (headers: Record<string, string>) =>
        fetch(`${baseUrl}/admin/settings`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${await token(OPERATOR)}`, 'content-type': 'application/pdf', ...headers },
          body: Buffer.from('%PDF-1.4\n{"reason": "In the file, which is not JSON"}'),
        });
      expect(await refusal(await file({}))).toEqual([400, 'Every admin change needs a reason: send reason, 3 to 500 characters, in the X-FF-Reason header, URI-encoded: the body is the file']);
      expect((await file({ 'x-ff-reason': 'Certificate%20from%20the%20tax%20platform' })).status).toBe(200);
    });

    it('take no reason for a route that changes nothing, such as a preview: still for operators only (P-73)', async () => {
      const preview = async (claims: JWTPayload) =>
        fetch(`${baseUrl}/admin/settings/preview`, {
          method: 'POST',
          headers: { authorization: `Bearer ${await token(claims)}`, 'content-type': 'application/json' },
          body: '{}',
        });

      const res = await preview(OPERATOR);
      expect([res.status, await res.json()]).toEqual([201, { previewedBy: 'kc-user-1' }]);
      expect(await refusal(await preview({ azp: 'ff-admin' }))).toEqual([403, "The admin routes are for FF's operators"]);
    });

    it("keep a token issued to the admin dashboard off the customer routes, before any user is created", async () => {
      expect(await refusal(await get('/functions', `Bearer ${await token(OPERATOR)}`))).toEqual([
        403,
        "This token was issued to the admin dashboard: the customer routes take the console's",
      ]);
      expect(calls).toEqual([]);
    });
  });

  describe("the route's rules (P-12)", () => {
    const deploy = async () =>
      fetch(`${baseUrl}/functions`, { method: 'POST', headers: { authorization: `Bearer ${await token()}` } });

    it('lets an owner or a developer of an active account deploy', async () => {
      for (const role of ['owner', 'developer'] as const) {
        accounts.choice = asMember(role);

        expect((await deploy()).status).toBe(201);
      }
    });

    it('refuses a viewer: viewers only read', async () => {
      accounts.choice = asMember('viewer');
      const res = await deploy();

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ message: "The viewer role can't do this" });
    });

    it.each([
      [AccountStatus.PENDING, 'Your account is waiting for approval: you can deploy and invoke functions once it is approved'],
      [AccountStatus.REJECTED, 'Your account was not approved'],
      [AccountStatus.SUSPENDED, 'Your account is suspended'],
      [AccountStatus.CLOSED, 'Your account is closed'],
    ])('refuses a %s account, saying why', async (status, message) => {
      accounts.choice = asMember('owner', status);
      const res = await deploy();

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ message });
    });

    it('answers a user without an account with that reason, before any rule', async () => {
      const res = await deploy();

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ message: 'This user has no account yet: create one with POST /accounts' });
    });
  });

  it.each([
    ['no Authorization header', undefined, 'Authentication required'],
    ['another scheme', 'Basic YWRtaW46YWRtaW4=', 'Authentication required: send "Authorization: Bearer <token>"'],
    ['a bearer without a token', 'Bearer ', 'Authentication required: send "Authorization: Bearer <token>"'],
    ['an API key that is not valid', `Bearer ffk_0123456789ab_${'a'.repeat(43)}`, 'The API key is invalid'],
  ])('answers 401 to %s, saying how to authenticate', async (_label, authorization, message) => {
    const res = await get('/identity', authorization);

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="ff"');
    expect(await res.json()).toMatchObject({ message });
  });

  it.each<[string, () => Promise<string>, string]>([
    ['an expired token', () => token({ exp: Math.floor(Date.now() / 1000) - 60 }), 'The token has expired'],
    ['a token from another issuer', () => token({ iss: 'https://evil.example/realms/ff' }), 'The token was issued by another issuer'],
    ['a token for another audience', () => token({ aud: 'account' }), 'The token is not meant for this API'],
    ['a token not valid yet', () => token({ nbf: Math.floor(Date.now() / 1000) + 120 }), 'The token is not valid yet'],
    ['a token without a subject', () => token({ sub: undefined }), 'The token has no valid subject'],
    ['a token whose subject is not a string', () => token({ sub: { id: 'kc-user-1' } as unknown as string }), 'The token has no valid subject'],
    ['a token signed with a key that is not the realm\'s', async () => token({}, await newKey('key-1')), 'The token is invalid'],
    ['a token naming a key the realm never had', async () => token({}, await newKey('stolen-key')), 'The token is invalid'],
    ['an unsigned token (alg "none")', async () => {
      const [, payload] = (await token()).split('.');
      return `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`;
    }, 'The token is invalid'],
    ['an HMAC token, signed with the public key as the secret', async () => {
      const secret = new TextEncoder().encode(JSON.stringify(await publish(key)));
      return new SignJWT({ sub: 'kc-user-1', email_verified: true })
        .setProtectedHeader({ alg: 'HS256', kid: key.kid })
        .setIssuer(issuer.issuer)
        .setAudience(AUDIENCE)
        .setExpirationTime('5m')
        .sign(secret);
    }, 'The token is invalid'],
    ['a token with a broken signature', async () => `${(await token()).slice(0, -4)}AAAA`, 'The token is invalid'],
  ])('answers 401 to %s', async (_label, make, message) => {
    const res = await get('/identity', `Bearer ${await make()}`);

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ message });
  });

  it('accepts a token that expired within the 30 s of clock skew', async () => {
    const res = await get('/identity', `Bearer ${await token({ exp: Math.floor(Date.now() / 1000) - 10 })}`);

    expect(res.status).toBe(200);
  });

  it('answers 403 to a valid token whose user has not verified their e-mail', async () => {
    for (const verified of [false, undefined]) {
      const res = await get('/identity', `Bearer ${await token({ email_verified: verified })}`);

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ message: 'Verify your e-mail address first' });
    }
  });

  it('caches the keys, and reads them again for a key it lacks once the cooldown has passed, so a rotation goes through', async () => {
    const verifier = new TokenVerifier({ getOrThrow: () => ({ issuer: issuer.issuer, audience: AUDIENCE }) } as never);
    verifier.keyRefetchCooldownMs = 1_000; // 30 s in production
    // Keys and tokens made first: generating an RSA key can take longer than the cooldown.
    const rotated = await newKey('key-2');
    const [current, fromRotated, forged] = [await token(), await token({}, rotated), await token({}, await newKey('forged'))];
    const fetches = () => issuer.state.jwksFetches;
    const start = fetches();

    await verifier.verify(current);
    await verifier.verify(current);
    expect(fetches()).toBe(start + 1); // cached

    issuer.state.keys = [await publish(key), await publish(rotated)];
    // Within the cooldown, a key the backend lacks is refused without reading the keys again.
    await expect(verifier.verify(fromRotated)).rejects.toBeInstanceOf(InvalidTokenError);
    expect(fetches()).toBe(start + 1);

    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await expect(verifier.verify(fromRotated)).resolves.toMatchObject({ userId: 'kc-user-1' });
    expect(fetches()).toBe(start + 2);

    // A forged key ID right after can't make it read them again.
    await expect(verifier.verify(forged)).rejects.toBeInstanceOf(InvalidTokenError);
    expect(fetches()).toBe(start + 2);
  });

  it('reads the keys where FF_OIDC_JWKS_URL says, without a discovery, and still checks the issuer the token names', async () => {
    const verifier = new TokenVerifier({ getOrThrow: () => ({ issuer: issuer.issuer, audience: AUDIENCE, jwksUrl: `${issuer.issuer}/certs` }) } as never);
    const [discoveries, fetches] = [issuer.state.discoveries, issuer.state.jwksFetches];

    await expect(verifier.verify(await token())).resolves.toMatchObject({ userId: 'kc-user-1' });
    expect([issuer.state.discoveries - discoveries, issuer.state.jwksFetches - fetches]).toEqual([0, 1]);

    const elsewhere = new TokenVerifier({ getOrThrow: () => ({ issuer: 'https://login.ff.example/realms/ff', audience: AUDIENCE, jwksUrl: `${issuer.issuer}/certs` }) } as never);
    await expect(elsewhere.verify(await token())).rejects.toThrow('The token was issued by another issuer');
  });

  it('lets anyone call a @Public() route', async () => {
    const res = await get('/open');

    expect(res.status).toBe(200);
  });

  describe('development mode', () => {
    beforeEach(() => {
      mode = 'dev';
    });

    it("reads no token: the caller owns FF_DEV_ACCOUNT_ID, which exists from the first call", async () => {
      const res = await get('/functions');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ accountId: '000000000001', accountStatus: 'active', planId: 'beta', userId: 'dev', role: 'owner' });
      expect(accounts.developmentAccounts).toEqual(['000000000001']);
      expect(calls).toEqual([]); // nobody joins anything without a user (P-16)
    });

    it('acts as the account that X-FF-Dev-Account names', async () => {
      const res = await fetch(`${baseUrl}/functions`, { headers: { 'x-ff-dev-account': '000000000002' } });

      expect(await res.json()).toMatchObject({ accountId: '000000000002' });
    });

    it.each([['an empty value', ''], ['too few digits', '12345'], ['a letter', '00000000000a']])(
      'refuses X-FF-Dev-Account with %s',
      async (_label, value) => {
        const res = await fetch(`${baseUrl}/functions`, { headers: { 'x-ff-dev-account': value } });

        expect(res.status).toBe(400);
        expect(accounts.developmentAccounts).toEqual([]);
      },
    );

    it("applies the route's rules there too", async () => {
      accounts.developmentStatus = AccountStatus.PENDING;

      const res = await fetch(`${baseUrl}/functions`, { method: 'POST' });

      expect(res.status).toBe(403);
    });
  });

  it("answers a platform failure, not 401, when the realm's keys can't be read", async () => {
    const unreachable = () => 'http://127.0.0.1:1/realms/ff';
    const verifier = new TokenVerifier({ getOrThrow: () => ({ issuer: unreachable(), audience: AUDIENCE }) } as never);
    const failure = await verifier.verify(await token()).catch((error: unknown) => error);
    const isolated = await startApp(unreachable);
    try {
      const res = await fetch(`${await isolated.getUrl()}/identity`, { headers: { authorization: `Bearer ${await token()}` } });

      // Not the token's fault: neither 401 nor 403, but D4's generic answer.
      expect(failure).not.toBeInstanceOf(InvalidTokenError);
      expect(failure).not.toBeInstanceOf(UnverifiedEmailError);
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ message: expect.stringMatching(/^Internal error\. Request ID: /) });
    } finally {
      await isolated.close();
    }
  });
});
