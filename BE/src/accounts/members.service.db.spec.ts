/**
 * L2: members and invitations against a real PostgreSQL server (client-readiness
 * plan, P-16, D4), in a scratch database that is dropped after.
 *   docker compose up -d --wait postgres && npm run test:db
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { ApiKey } from '../api-keys/entities/api-key.entity';
import { databaseConfiguration } from '../config/configuration';
import { ScratchDatabase, createScratchDatabase } from '../database/scratch-database';
import { Mail, MailService } from '../mail/mail.service';
import { Account, AccountStatus } from './entities/account.entity';
import { Invitation } from './entities/invitation.entity';
import { Membership } from './entities/membership.entity';
import { User } from './entities/user.entity';
import { MAX_OPEN_INVITATIONS, MembersService } from './members.service';

const run = process.env.FF_DB_IT === '1' ? describe : describe.skip;

run('members and invitations (L2, P-16)', () => {
  let db: ScratchDatabase;
  let members: MembersService;
  const sent: Mail[] = [];
  let n = 0;
  const NOW = new Date('2026-10-17T10:00:00Z');
  const DAY = 24 * 60 * 60 * 1000;

  const user = (email = `user${++n}@example.tn`) =>
    db.dataSource.getRepository(User).save({ oidcSub: `kc-${++n}`, email, name: null });
  /** An active account, with `owner` as its owner. */
  async function account(owner: User): Promise<string> {
    const id = String(300000000000 + ++n);
    await db.dataSource.getRepository(Account).save({ id, name: `Atelier ${n}`, planId: 'beta', status: AccountStatus.ACTIVE });
    await db.dataSource.getRepository(Membership).save({ accountId: id, userId: owner.id, role: 'owner' });
    return id;
  }
  const roleOf = async (accountId: string, userId: string) =>
    (await db.dataSource.getRepository(Membership).findOneBy({ accountId, userId }))?.role ?? 'none';
  const refusal = (promise: Promise<unknown>) => promise.then(() => 'accepted', (error: Error) => `${error.constructor.name}: ${error.message}`);

  beforeAll(async () => {
    db = await createScratchDatabase(databaseConfiguration(), 'ff_test');
    await db.dataSource.runMigrations({ transaction: 'each' });
    const mail = { send: async (message: Mail) => sent.push(message) > 0 } as unknown as MailService;
    const config = { getOrThrow: () => ({ consoleUrl: 'https://console.ff.example' }) } as unknown as ConfigService;
    const ds = db.dataSource;
    members = new MembersService(ds.getRepository(Membership), ds.getRepository(Invitation), ds.getRepository(Account), ds, mail, config);
  });

  afterAll(async () => {
    await db?.drop();
  });

  beforeEach(() => {
    sent.length = 0;
  });

  it('invites an address in lowercase, for seven days, and e-mails it a link to the console', async () => {
    const owner = await user('owner@example.tn');
    const id = await account(owner);

    const { name } = await db.dataSource.getRepository(Account).findOneByOrFail({ id });

    const invitation = await members.invite(id, owner, { email: ' Salma@Example.TN ', role: 'developer' }, NOW);

    expect(invitation).toMatchObject({ email: 'salma@example.tn', role: 'developer', invitedBy: owner.id, expired: false });
    expect(invitation.expiresAt.toISOString()).toBe('2026-10-24T10:00:00.000Z');
    expect(sent).toEqual([
      {
        to: 'salma@example.tn',
        subject: `owner@example.tn invited you to the FF account "${name}"`,
        text: expect.stringContaining('Log in to the FF console with this address before 2026-10-24 to join: https://console.ff.example'),
      },
    ]);
  });

  it('renews an open invitation when the same address is invited again, with the new role', async () => {
    const owner = await user();
    const id = await account(owner);
    await members.invite(id, owner, { email: 'again@example.tn', role: 'viewer' }, NOW);

    await members.invite(id, owner, { email: 'again@example.tn', role: 'developer' }, new Date(NOW.getTime() + 6 * DAY));

    const open = await db.dataSource.getRepository(Invitation).findBy({ accountId: id });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ role: 'developer', expiresAt: new Date(NOW.getTime() + 13 * DAY) });
    expect(sent).toHaveLength(2);
  });

  it('refuses to invite a member, whatever the case of the address', async () => {
    const owner = await user('Boss@Example.TN');
    const id = await account(owner);

    expect(await refusal(members.invite(id, owner, { email: 'boss@example.tn', role: 'viewer' }, NOW))).toBe(
      'BadRequestException: boss@example.tn is already a member of this account',
    );
    expect(sent).toEqual([]);
  });

  it(`keeps at most ${MAX_OPEN_INVITATIONS} open invitations per account`, async () => {
    const owner = await user();
    const id = await account(owner);
    for (let i = 0; i < MAX_OPEN_INVITATIONS; i++) await members.invite(id, owner, { email: `p${i}@example.tn`, role: 'viewer' }, NOW);

    expect(await refusal(members.invite(id, owner, { email: 'one-more@example.tn', role: 'viewer' }, NOW))).toBe(
      `BadRequestException: An account has at most ${MAX_OPEN_INVITATIONS} open invitations: cancel one first`,
    );
    // Sending one again is still possible.
    await expect(members.invite(id, owner, { email: 'p0@example.tn', role: 'viewer' }, NOW)).resolves.toBeDefined();
  });

  it("lets the invited address's user join on its next call, once, with the invitation's role", async () => {
    const owner = await user();
    const id = await account(owner);
    await members.invite(id, owner, { email: 'newcomer@example.tn', role: 'developer' }, NOW);
    const newcomer = await user('NewComer@example.tn'); // Keycloak may keep the address's case

    await members.acceptInvitations(newcomer, new Date(NOW.getTime() + DAY));
    await members.acceptInvitations(newcomer, new Date(NOW.getTime() + DAY)); // the next call changes nothing

    expect(await roleOf(id, newcomer.id)).toBe('developer');
    expect(await db.dataSource.getRepository(Invitation).findOneByOrFail({ accountId: id })).toMatchObject({ acceptedBy: newcomer.id });
    expect((await members.list(id)).invitations).toEqual([]);
  });

  it('lets nobody join with an expired invitation, or with another address', async () => {
    const owner = await user();
    const id = await account(owner);
    await members.invite(id, owner, { email: 'late@example.tn', role: 'viewer' }, NOW);
    const late = await user('late@example.tn');
    const other = await user('other@example.tn');

    await members.acceptInvitations(other, NOW);
    await members.acceptInvitations(late, new Date(NOW.getTime() + 7 * DAY));

    expect([await roleOf(id, late.id), await roleOf(id, other.id)]).toEqual(['none', 'none']);
    expect((await members.list(id, new Date(NOW.getTime() + 7 * DAY))).invitations).toEqual([
      expect.objectContaining({ email: 'late@example.tn', expired: true }),
    ]);
  });

  it('keeps the role of a member who is invited again: the invitation is only marked accepted', async () => {
    const owner = await user();
    const id = await account(owner);
    const viewer = await user('viewer@example.tn');
    await members.invite(id, owner, { email: 'viewer@example.tn', role: 'viewer' }, NOW);
    await members.acceptInvitations(viewer, NOW);
    await db.dataSource.getRepository(Membership).update({ accountId: id, userId: viewer.id }, { role: 'owner' });
    // An invitation sent before the change, accepted after it:
    await db.dataSource.getRepository(Invitation).insert({ accountId: id, email: 'viewer@example.tn', role: 'viewer', invitedBy: owner.id, expiresAt: new Date(NOW.getTime() + DAY) });

    await members.acceptInvitations(viewer, NOW);

    expect(await roleOf(id, viewer.id)).toBe('owner');
  });

  it("lists members with their address and role, and cancels an open invitation, not another account's", async () => {
    const owner = await user('lister@example.tn');
    const id = await account(owner);
    const otherOwner = await user();
    const other = await account(otherOwner);
    const invitation = await members.invite(id, owner, { email: 'pending@example.tn', role: 'viewer' }, NOW);

    expect(await members.list(id, NOW)).toMatchObject({
      members: [{ userId: owner.id, email: 'lister@example.tn', role: 'owner' }],
      invitations: [{ id: invitation.id, email: 'pending@example.tn', role: 'viewer', expired: false }],
    });
    expect(await refusal(members.cancelInvitation(other, invitation.id))).toBe(`NotFoundException: Invitation ${invitation.id} not found`);
    await members.cancelInvitation(id, invitation.id);
    expect((await members.list(id, NOW)).invitations).toEqual([]);
  });

  it('changes roles and removes members, but always keeps an owner', async () => {
    const owner = await user();
    const id = await account(owner);
    const second = await user();
    await db.dataSource.getRepository(Membership).save({ accountId: id, userId: second.id, role: 'developer' });

    expect(await refusal(members.changeRole(id, owner.id, 'developer'))).toBe(
      'BadRequestException: An account needs an owner: make another member owner first',
    );
    expect(await refusal(members.remove(id, owner.id))).toBe('BadRequestException: An account needs an owner: make another member owner first');

    await expect(members.changeRole(id, second.id, 'owner')).resolves.toMatchObject({ userId: second.id, role: 'owner' });
    await members.remove(id, owner.id); // two owners: the first may leave
    expect([await roleOf(id, owner.id), await roleOf(id, second.id)]).toEqual(['none', 'owner']);
    expect(await refusal(members.remove(id, owner.id))).toBe(`NotFoundException: Member ${owner.id} not found`);
  });

  it("keeps an owner when two owners demote each other at once", async () => {
    const a = await user();
    const id = await account(a);
    const b = await user();
    await db.dataSource.getRepository(Membership).save({ accountId: id, userId: b.id, role: 'owner' });
    // Each change now takes 200 ms, so changes that didn't wait for each other would both count two owners.
    await db.dataSource.query(`
      CREATE FUNCTION slow_update() RETURNS trigger AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER slow_update BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION slow_update();`);

    const outcomes = await Promise.allSettled([members.changeRole(id, b.id, 'developer'), members.changeRole(id, a.id, 'developer')]);
    await db.dataSource.query('DROP TRIGGER slow_update ON memberships; DROP FUNCTION slow_update();');

    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await db.dataSource.getRepository(Membership).countBy({ accountId: id, role: 'owner' })).toBe(1);
  });

  it("stops a removed member's API keys at once (P-13)", async () => {
    const owner = await user();
    const id = await account(owner);
    const developer = await user();
    await db.dataSource.getRepository(Membership).save({ accountId: id, userId: developer.id, role: 'owner' });
    const keys = new ApiKeysService(db.dataSource.getRepository(ApiKey), db.dataSource.getRepository(Membership));
    const { key } = await keys.create(id, developer.id, { name: 'ci', scopes: ['functions:read'] });

    await members.remove(id, developer.id);

    expect(await refusal(keys.authenticate(key))).toBe("UnauthorizedException: The API key's creator is no longer a member of its account");
  });

  it('answers 404 for a member of another account', async () => {
    const owner = await user();
    const id = await account(owner);
    const stranger = await user();
    await account(stranger);

    expect(await refusal(members.changeRole(id, stranger.id, 'viewer'))).toBe(`NotFoundException: Member ${stranger.id} not found`);
    expect(await refusal(members.remove(id, stranger.id))).toBe(`NotFoundException: Member ${stranger.id} not found`);
    expect(await roleOf(id, stranger.id)).toBe('none');
  });
});
