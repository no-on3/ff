/**
 * L2: accounts, users and memberships against a real PostgreSQL server
 * (client-readiness plan, P-12), in a scratch database that is dropped after.
 * The service's queries use relations, relation filters and a transaction,
 * which only a real database checks.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { databaseConfiguration } from '../config/configuration';
import { AuditEntry } from '../audit/audit-entry.entity';
import { AuditService } from '../audit/audit.service';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Mail, MailService } from '../mail/mail.service';
import { Orchestrator } from '../orchestrator/orchestrator.types';
import { PlansService } from '../plans/plans.service';
import { BETA_LIMITS } from '../plans/test-fixtures';
import { AccountsService } from './accounts.service';
import { Account, AccountStatus } from './entities/account.entity';
import { Membership } from './entities/membership.entity';
import { Plan } from './entities/plan.entity';
import { User } from './entities/user.entity';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;

run('accounts, users and memberships (L2, P-12)', () => {
  let db: ScratchDatabase;
  let service: AccountsService;
  let plans: PlansService;
  const sent: Mail[] = [];
  let operatorEmail = 'ops@ff.example';

  const identity = (n: number) => ({ userId: `kc-${n}`, email: `user${n}@example.tn`, name: `User ${n}` });

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    const mail = { send: async (message: Mail) => sent.push(message) > 0 } as unknown as MailService;
    const config = { getOrThrow: () => ({ operatorEmail, adminUrl: 'https://admin.ff.example' }) } as unknown as ConfigService;
    const ds = db.dataSource;
    const audit = new AuditService(ds.getRepository(AuditEntry));
    plans = new PlansService(ds.getRepository(Plan), ds.getRepository(Account), {} as Orchestrator, audit);
    service = new AccountsService(ds.getRepository(Account), ds.getRepository(User), ds.getRepository(Membership), ds, mail, config, plans, audit);
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    sent.length = 0;
    operatorEmail = 'ops@ff.example';
  });

  it("creates a user on the first call, keyed by the token's subject, and finds the same one after", async () => {
    const first = await service.userFor(identity(1));
    const again = await service.userFor(identity(1));
    const moved = await service.userFor({ ...identity(1), email: 'new-address@example.tn' });

    expect(first).toMatchObject({ oidcSub: 'kc-1', email: 'user1@example.tn', name: 'User 1', locale: 'fr-TN' });
    expect(again.id).toBe(first.id);
    expect(moved).toMatchObject({ id: first.id, email: 'new-address@example.tn' }); // changed in Keycloak
    expect(await db.dataSource.getRepository(User).count({ where: { oidcSub: 'kc-1' } })).toBe(1);
  });

  it('creates one user only when two first calls come at once', async () => {
    const [a, b] = await Promise.all([service.userFor(identity(2)), service.userFor(identity(2))]);

    expect(a.id).toBe(b.id);
  });

  it('gives a user without an account 403, saying how to create one', async () => {
    const user = await service.userFor(identity(3));

    expect(await service.choose(user, undefined)).toEqual({
      problem: new ForbiddenException('This user has no account yet: create one with POST /accounts'),
    });
  });

  it('creates a pending account owned by its creator, and e-mails you to approve it', async () => {
    const user = await service.userFor(identity(4));

    const account = await service.create(user, { name: 'Atelier Sfax', useCase: 'Image resizing for our shop' });

    expect(account).toMatchObject({
      id: expect.stringMatching(/^\d{12}$/),
      name: 'Atelier Sfax',
      status: 'pending',
      role: 'owner',
      planId: 'beta',
      country: 'TN',
      taxId: null,
      internetEgress: false,
      useCase: 'Image resizing for our shop',
    });
    expect(await db.dataSource.getRepository(Membership).findOneBy({ accountId: account.id })).toMatchObject({
      userId: user.id,
      role: 'owner',
    });
    expect(sent).toEqual([
      {
        to: 'ops@ff.example',
        subject: `New account waiting for approval: Atelier Sfax (${account.id})`,
        text: expect.stringContaining('Approve or reject it: https://admin.ff.example/accounts?status=pending'),
      },
    ]);
    expect(sent[0].text).toContain('user4@example.tn created the account "Atelier Sfax"');
    expect(sent[0].text).toContain('What they plan to build: Image resizing for our shop');
  });

  it('lets a user have one account waiting for approval at a time', async () => {
    const user = await service.userFor(identity(5));
    await service.create(user, { name: 'First' });

    await expect(service.create(user, { name: 'Second' })).rejects.toThrow(
      new BadRequestException('You already have an account waiting for approval'),
    );
    expect(sent).toHaveLength(1);
  });

  it('creates the account even when nobody is set to approve it, without an e-mail', async () => {
    operatorEmail = '';
    const user = await service.userFor(identity(6));

    await expect(service.create(user, { name: 'Quiet' })).resolves.toMatchObject({ status: 'pending' });
    expect(sent).toEqual([]);
  });

  describe("choosing a user's account (D4)", () => {
    let user: User;
    let pending: string;
    let active: string;

    beforeAll(async () => {
      user = await service.userFor(identity(7));
      pending = (await service.create(user, { name: 'Waiting' })).id;
      // As P-71 will, until the admin routes exist.
      await db.dataSource.getRepository(Account).update(pending, { status: AccountStatus.ACTIVE });
      active = pending;
    });

    it("acts for the user's only account, with its status and the user's role", async () => {
      expect(await service.choose(user, undefined)).toEqual({
        principal: { accountId: active, accountStatus: 'active', planId: 'beta', userId: user.id, role: 'owner' },
      });
    });

    it('asks a user with several accounts to name one, and acts for the one named', async () => {
      const second = (await service.create(user, { name: 'Second' })).id;

      expect(await service.choose(user, undefined)).toEqual({
        problem: new BadRequestException('This user belongs to several accounts: name one in the X-FF-Account header'),
      });
      expect(await service.choose(user, second)).toMatchObject({ principal: { accountId: second, accountStatus: 'pending' } });
      expect(await service.choose(user, active)).toMatchObject({ principal: { accountId: active, accountStatus: 'active' } });
    });

    it("answers 404 for an account the user doesn't belong to, as for one that doesn't exist", async () => {
      const stranger = await service.userFor(identity(8));
      const theirs = (await service.create(stranger, { name: 'Not yours' })).id;

      expect(await service.choose(user, theirs)).toEqual({ problem: new NotFoundException(`Account ${theirs} not found`) });
      expect(await service.choose(user, '999999999999')).toEqual({ problem: new NotFoundException('Account 999999999999 not found') });
      expect(await service.choose(user, 'abc')).toEqual({ problem: new BadRequestException('X-FF-Account must be an account ID: 12 digits') });
    });
  });

  describe('an account, for its members (GET and PATCH /accounts/:id)', () => {
    it("shows an account to its members only, and lets only the owner change it", async () => {
      const owner = await service.userFor(identity(9));
      const developer = await service.userFor(identity(10));
      const outsider = await service.userFor(identity(11));
      const { id } = await service.create(owner, { name: 'Team' });
      await db.dataSource.getRepository(Membership).save({ accountId: id, userId: developer.id, role: 'developer' });

      await expect(service.get(developer, id)).resolves.toMatchObject({ id, role: 'developer' });
      await expect(service.get(outsider, id)).rejects.toThrow(new NotFoundException(`Account ${id} not found`));
      await expect(service.update(developer, id, { name: 'Renamed' })).rejects.toThrow(
        new ForbiddenException("The developer role can't change the account"),
      );
      await expect(service.update(outsider, id, { name: 'Renamed' })).rejects.toBeInstanceOf(NotFoundException);

      await expect(service.update(owner, id, { name: 'Renamed', taxId: '1234567/A/M/000' })).resolves.toMatchObject({
        name: 'Renamed',
        taxId: '1234567/A/M/000',
      });
      await expect(service.update(owner, id, { taxId: null })).resolves.toMatchObject({ name: 'Renamed', taxId: null });
    });

    it("lists the user's accounts, roles and plans in GET /me: the beta plan with the limits of P-15's migration", async () => {
      const user = await service.userFor(identity(12));
      const { id } = await service.create(user, { name: 'Mine' });

      expect(await service.me(user)).toEqual({
        user: { id: user.id, email: 'user12@example.tn', name: 'User 12', locale: 'fr-TN' },
        key: null,
        accounts: [{ id, name: 'Mine', status: 'pending', role: 'owner', plan: { id: 'beta', name: 'Beta', limits: BETA_LIMITS }, internetEgress: false, dataDeletionDueAt: null, dataDeletedAt: null, storageDisabledAt: null, storageDisabledReason: null, bucketStorageNotice: null }],
      });
    });

    it("shows an API key, in GET /me, itself and the account it acts for, with its creator's role, which bounds it", async () => {
      const user = await service.userFor(identity(15));
      const { id } = await service.create(user, { name: 'Keyed' });
      // FF's operator turned the account's internet egress on, which the beta plan leaves off.
      await db.dataSource.query(`UPDATE accounts SET status = 'active', internet_egress = true WHERE id = $1`, [id]);
      const principal = { accountId: id, accountStatus: AccountStatus.ACTIVE, planId: 'beta', keyId: '0123456789ab', keyName: 'laptop', userId: user.id, role: 'developer' as const, scopes: ['functions:read', 'logs:read'] };

      expect(await service.keyMe(principal)).toEqual({
        user: null,
        key: { id: '0123456789ab', name: 'laptop', scopes: ['functions:read', 'logs:read'] },
        accounts: [{ id, name: 'Keyed', status: 'active', role: 'developer', plan: { id: 'beta', name: 'Beta', limits: BETA_LIMITS }, internetEgress: true, dataDeletionDueAt: null, dataDeletedAt: null, storageDisabledAt: null, storageDisabledReason: null, bucketStorageNotice: null }],
      });
    });

    it("changes the language of a user's e-mails in PATCH /me, theirs only, for all their accounts, and keeps it", async () => {
      const user = await service.userFor(identity(13));
      await service.userFor(identity(14));

      expect((await service.updateMe(user, { locale: 'en' })).user).toEqual({ id: user.id, email: 'user13@example.tn', name: 'User 13', locale: 'en' });
      expect([(await service.userFor(identity(13))).locale, (await service.userFor(identity(14))).locale]).toEqual(['en', 'fr-TN']);
      expect((await service.updateMe(user, { locale: 'fr-TN' })).user?.locale).toBe('fr-TN');
      expect((await service.userFor(identity(13))).locale).toBe('fr-TN');
    });

    it("gives a closed account's members, in GET /me, when its data is deleted, and once done, when it was", async () => {
      const user = await service.userFor(identity(13));
      const { id } = await service.create(user, { name: 'Leaving' });
      const due = new Date('2026-11-17T10:32:45.123Z');
      await db.dataSource.query(`UPDATE accounts SET status = 'closed', data_deletion_due_at = $2 WHERE id = $1`, [id, due]);
      expect((await service.me(user)).accounts).toMatchObject([{ id, status: 'closed', dataDeletionDueAt: due, dataDeletedAt: null }]);

      const done = new Date('2026-11-17T11:00:04.000Z');
      await db.dataSource.query(`UPDATE accounts SET data_deleted_at = $2 WHERE id = $1`, [id, done]);

      expect((await service.me(user)).accounts).toMatchObject([{ id, dataDeletionDueAt: due, dataDeletedAt: done }]);
    });
  });

  it("creates development mode's account active, once", async () => {
    const [a, b] = await Promise.all([service.developmentAccount('000000000077'), service.developmentAccount('000000000077')]);

    expect(a).toMatchObject({ id: '000000000077', status: 'active', planId: 'beta', name: 'Development account 000000000077', internetEgress: false });
    expect(b.id).toBe(a.id);
    expect(await db.dataSource.getRepository(Account).count({ where: { id: '000000000077' } })).toBe(1);
  });

  // The plan's internetEgress is only the default for new accounts: the operator turns it on or off per account.
  it("gives a new account its plan's internet egress, which the beta plan has off", async () => {
    const beta = await plans.get('beta', { fresh: true });
    await db.dataSource.query(`UPDATE plans SET limits = limits || '{"internetEgress": true}' WHERE id = 'beta'`);
    await plans.get('beta', { fresh: true });
    try {
      const created = await service.create(await service.userFor(identity(90)), { name: 'Open Data Tunis' });
      const development = await service.developmentAccount('000000000078');

      expect([beta.limits.internetEgress, created.internetEgress, development.internetEgress]).toEqual([false, true, true]);
    } finally {
      await db.dataSource.query(`UPDATE plans SET limits = limits || '{"internetEgress": false}' WHERE id = 'beta'`);
      await plans.get('beta', { fresh: true });
    }
  });
});
