/**
 * L2: API keys against a real PostgreSQL server (client-readiness plan, P-13,
 * D3), in a scratch database that is dropped after.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Account, AccountStatus } from '../accounts/entities/account.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { User } from '../accounts/entities/user.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { API_KEY } from './api-key-format';
import { ApiKeysService, MAX_KEYS_PER_ACCOUNT } from './api-keys.service';
import { ApiKey } from './entities/api-key.entity';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;

run('API keys (L2, P-13)', () => {
  let db: ScratchDatabase;
  let service: ApiKeysService;
  let owner: User;
  let n = 0;

  /** An active account with `owner` as its owner. */
  async function account(): Promise<string> {
    const id = String(100000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name: `Account ${n}`, planId: 'beta', status: AccountStatus.ACTIVE });
    await db.dataSource.getRepository(Membership).save({ accountId: id, userId: owner.id, role: 'owner' });
    return id;
  }
  const refusal = (promise: Promise<unknown>) => promise.then(() => 'accepted', (error: Error) => `${error.constructor.name}: ${error.message}`);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    owner = await db.dataSource.getRepository(User).save({ oidcSub: 'kc-owner', email: 'owner@example.tn' });
    service = new ApiKeysService(db.dataSource.getRepository(ApiKey), db.dataSource.getRepository(Membership));
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('shows a new key once, and keeps only its hash', async () => {
    const accountId = await account();

    const created = await service.create(accountId, owner.id, { name: 'CI', scopes: ['functions:read', 'functions:invoke'] });

    expect(created.key).toMatch(API_KEY);
    expect(created).toMatchObject({ name: 'CI', scopes: ['functions:read', 'functions:invoke'], createdBy: owner.id, expiresAt: null });
    const [row] = await db.dataSource.query('SELECT * FROM api_keys WHERE id = $1', [created.id]);
    expect(JSON.stringify(row)).not.toContain(created.key.split('_')[2]); // the secret is nowhere
    expect(row.secret_sha256).toHaveLength(32);
    const listed = await service.list(accountId);
    expect(listed).toEqual([expect.not.objectContaining({ key: expect.anything() })]);
    expect(Object.keys(listed[0])).not.toContain('secretSha256');
  });

  it("acts for its account with its scopes, and its creator's current role", async () => {
    const accountId = await account();
    const { key, id } = await service.create(accountId, owner.id, { name: 'deploys', scopes: ['functions:write'] });

    await expect(service.authenticate(key)).resolves.toEqual({
      accountId,
      accountStatus: 'active',
      keyId: id,
      userId: owner.id,
      role: 'owner',
      scopes: ['functions:write'],
    });

    // Lowered to viewer: the key can only do what a viewer does, at once.
    await db.dataSource.getRepository(Membership).update({ accountId, userId: owner.id }, { role: 'viewer' });
    await expect(service.authenticate(key)).resolves.toMatchObject({ role: 'viewer' });

    // Gone from the account: the key stops working.
    await db.dataSource.getRepository(Membership).delete({ accountId, userId: owner.id });
    expect(await refusal(service.authenticate(key))).toBe(
      "UnauthorizedException: The API key's creator is no longer a member of its account",
    );
  });

  it('gives one answer for an unknown key, a wrong secret and a malformed key', async () => {
    const accountId = await account();
    const { key } = await service.create(accountId, owner.id, { name: 'k', scopes: ['functions:read'] });
    const secret = key.split('_')[2];
    const wrongSecret = key.replace(secret, `${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`);

    for (const value of [wrongSecret, `ffk_aaaaaaaaaaaa_${secret}`, 'ffk_short']) {
      expect(await refusal(service.authenticate(value))).toBe('UnauthorizedException: The API key is invalid');
    }
  });

  it('stops a revoked key at once; another account cannot revoke it', async () => {
    const accountId = await account();
    const other = await account();
    const { key, id } = await service.create(accountId, owner.id, { name: 'k', scopes: ['functions:read'] });

    await expect(service.revoke(other, id)).rejects.toThrow(new NotFoundException(`API key ${id} not found`));
    await expect(service.authenticate(key)).resolves.toMatchObject({ keyId: id });

    const revoked = await service.revoke(accountId, id, new Date('2026-10-17T10:00:00Z'));
    const again = await service.revoke(accountId, id, new Date('2026-10-17T11:00:00Z'));

    expect(again.revokedAt).toEqual(revoked.revokedAt); // the first revocation stands
    expect(await refusal(service.authenticate(key))).toBe('UnauthorizedException: The API key was revoked');
  });

  it('refuses an expiry in the past, and stops a key once it expires', async () => {
    const accountId = await account();
    const now = new Date('2026-10-17T10:00:00Z');

    expect(await refusal(service.create(accountId, owner.id, { name: 'k', scopes: ['functions:read'], expiresAt: '2026-10-17T09:00:00Z' }, now))).toBe(
      'BadRequestException: expiresAt must be in the future',
    );
    const { key } = await service.create(accountId, owner.id, { name: 'k', scopes: ['functions:read'], expiresAt: '2026-10-17T12:00:00Z' }, now);

    await expect(service.authenticate(key, new Date('2026-10-17T11:59:00Z'))).resolves.toBeDefined();
    expect(await refusal(service.authenticate(key, new Date('2026-10-17T12:00:00Z')))).toBe('UnauthorizedException: The API key has expired');
  });

  it(`keeps at most ${MAX_KEYS_PER_ACCOUNT} working keys per account; revoking one makes room`, async () => {
    const accountId = await account();
    const keys = [];
    for (let i = 0; i < MAX_KEYS_PER_ACCOUNT; i++) keys.push(await service.create(accountId, owner.id, { name: `k${i}`, scopes: ['functions:read'] }));

    await expect(service.create(accountId, owner.id, { name: 'one more', scopes: ['functions:read'] })).rejects.toThrow(
      new BadRequestException(`An account has at most ${MAX_KEYS_PER_ACCOUNT} keys: revoke one first`),
    );
    await service.revoke(accountId, keys[0].id);
    await expect(service.create(accountId, owner.id, { name: 'one more', scopes: ['functions:read'] })).resolves.toBeDefined();
  });

  it('records when a key was last used, at most once a minute', async () => {
    const accountId = await account();
    const { key, id } = await service.create(accountId, owner.id, { name: 'k', scopes: ['functions:read'] });
    const lastUsed = async () => {
      await new Promise((resolve) => setTimeout(resolve, 50)); // the write doesn't hold up the request
      return (await db.dataSource.getRepository(ApiKey).findOneByOrFail({ id })).lastUsedAt?.toISOString();
    };

    await service.authenticate(key, new Date('2026-10-17T10:00:00Z'));
    expect(await lastUsed()).toBe('2026-10-17T10:00:00.000Z');
    await service.authenticate(key, new Date('2026-10-17T10:00:30Z'));
    expect(await lastUsed()).toBe('2026-10-17T10:00:00.000Z');
    await service.authenticate(key, new Date('2026-10-17T10:01:00Z'));
    expect(await lastUsed()).toBe('2026-10-17T10:01:00.000Z');
  });
});
