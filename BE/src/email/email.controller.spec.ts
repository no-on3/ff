/**
 * L1: the routes of customers' mail in FF's API (ADR 0012): who may call each,
 * what the bodies and queries may hold, and how the services' answers and
 * refusals come back, through HTTP. The identities themselves, in FF's
 * database and through the SES endpoint, are ses.db.spec.ts's; the messages
 * sent, email-sending.db.spec.ts's.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AccountStatus } from '../accounts/entities/account.entity';
import { Principal } from '../auth/principal';
import { ACTIVE_ACCOUNT, ROLES, SCOPE } from '../auth/route-rules';
import { EmailAccountService } from './email-account.service';
import { EmailIdentitiesService, IdentityRefusal } from './email-identities.service';
import { EmailIdentity, EmailIdentityStatus, EmailIdentityType } from './email-identity.entity';
import { EmailMessage, EmailMessageStatus } from './email-message.entity';
import { EmailMessagesService, SendRefusal, SendRefusalKind } from './email-messages.service';
import { EmailSuppression, SuppressionReason } from './email-suppression.entity';
import { EmailSuppressionsService } from './email-suppressions.service';
import { EmailController } from './email.controller';

const ACCOUNT = '000000000001';
const reflector = new Reflector();
const rules = (handler: keyof EmailController) => {
  const method = EmailController.prototype[handler];
  return {
    roles: reflector.get<string[] | undefined>(ROLES, method) ?? 'anyone',
    activeAccount: reflector.get<boolean | undefined>(ACTIVE_ACCOUNT, method) ?? false,
    scope: reflector.get<string | undefined>(SCOPE, method) ?? 'no key',
  };
};
const AT = new Date('2026-10-30T08:00:00Z');
const DOMAIN = {
  id: 'id-1',
  accountId: ACCOUNT,
  identity: 'shop.example.tn',
  type: EmailIdentityType.DOMAIN,
  status: EmailIdentityStatus.SUCCESS,
  dkimSelector: 'ff0a1b2c3d',
  dkimPublicKey: 'MIIB',
  mailFromVerified: false,
  verifiedAt: AT,
  createdAt: AT,
} as EmailIdentity;
const RECORDS = [{ purpose: 'DKIM', type: 'TXT', name: 'ff0a1b2c3d._domainkey.shop.example.tn', value: 'v=DKIM1; k=rsa; p=MIIB' }];

describe('/email (L1)', () => {
  const identities = {
    list: jest.fn(async () => [DOMAIN]),
    find: jest.fn(async (): Promise<EmailIdentity | null> => DOMAIN),
    create: jest.fn(async (): Promise<EmailIdentity> => DOMAIN),
    remove: jest.fn(async () => true),
    checkNow: jest.fn(async () => DOMAIN),
    recordsOf: jest.fn((row: EmailIdentity) => (row.type === EmailIdentityType.DOMAIN ? RECORDS : [])),
  };
  const suppressions = {
    list: jest.fn(async (): Promise<{ suppressions: EmailSuppression[]; next: string | null } | null> => ({ suppressions: [], next: null })),
    put: jest.fn(async (_caller: unknown, accountId: string, address: string, reason: SuppressionReason) => ({ accountId, address: address.toLowerCase(), reason, messageId: null, feedback: null, updatedAt: AT })),
    remove: jest.fn(async () => true),
  };
  const account = { state: jest.fn(async () => ({ sandbox: true, sendingEnabled: true, enforcementStatus: 'HEALTHY', max24HourSend: 200, maxSendRate: 1, sentLast24Hours: 0 })) };
  const MESSAGE = {
    id: '0f8e4c1a-6b1d-4d55-9a3e-2b7c9d1e5f00',
    accountId: ACCOUNT,
    identity: 'shop.example.tn',
    fromAddress: 'orders@shop.example.tn',
    returnPath: 'b-0f8e4c1a-6b1d-4d55-9a3e-2b7c9d1e5f00@bounces.mail.localhost',
    recipients: [
      { address: 'ana@shop.example.tn', status: 'SENT' },
      { address: 'gone@shop.example.tn', status: 'BOUNCED', permanent: true, diagnostic: 'smtp; 550 5.1.1 User unknown' },
    ],
    recipientCount: 2,
    sizeBytes: 812,
    status: EmailMessageStatus.SENT,
    attempts: 1,
    nextAttemptAt: AT,
    lastError: null,
    createdAt: AT,
    sentAt: AT,
  } as EmailMessage;
  const messages = { send: jest.fn(async () => MESSAGE.id), latest: jest.fn(async () => [MESSAGE]) };
  const principal: Principal = { accountId: ACCOUNT, accountStatus: AccountStatus.ACTIVE, planId: 'beta', role: 'developer' };
  let app: INestApplication;
  let baseUrl: string;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EmailController],
      providers: [
        { provide: EmailIdentitiesService, useValue: identities },
        { provide: EmailSuppressionsService, useValue: suppressions },
        { provide: EmailAccountService, useValue: account },
        { provide: EmailMessagesService, useValue: messages },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.use((req: { principal?: Principal }, _res: unknown, next: () => void) => {
      req.principal = principal;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('lets every member read them; writers add, prove and change them in an active account, and delete them in any', () => {
    for (const handler of ['list', 'get', 'accountView', 'listSuppressions', 'listMessages'] as const) expect(rules(handler)).toEqual({ roles: 'anyone', activeAccount: false, scope: 'email:read' });
    for (const handler of ['create', 'verify', 'putSuppression', 'send'] as const) expect(rules(handler)).toEqual({ roles: ['owner', 'developer'], activeAccount: true, scope: 'email:write' });
    for (const handler of ['remove', 'removeSuppression'] as const) expect(rules(handler)).toEqual({ roles: ['owner', 'developer'], activeAccount: false, scope: 'email:write' });
  });

  it("adds a domain for the caller's account, with the records it publishes and its own return path", async () => {
    const made = await call('POST', '/email/identities', { identity: 'Shop.Example.TN' });

    expect(made).toEqual({
      status: 201,
      body: {
        identity: 'shop.example.tn',
        type: 'DOMAIN',
        status: 'SUCCESS',
        sendingEnabled: true,
        dkimSelector: 'ff0a1b2c3d',
        mailFromDomain: 'bounces.mail.shop.example.tn',
        mailFromVerified: false,
        records: RECORDS,
        verifiedAt: AT.toISOString(),
        createdAt: AT.toISOString(),
      },
    });
    expect(identities.create).toHaveBeenCalledWith({ accountId: ACCOUNT }, 'Shop.Example.TN');
  });

  it("answers the service's refusals: one there already 409, past the plan or not a name 400, none by that name 404", async () => {
    identities.create.mockRejectedValueOnce(new IdentityRefusal('exists', 'The account has the identity shop.example.tn already'));
    expect(await call('POST', '/email/identities', { identity: 'shop.example.tn' })).toMatchObject({ status: 409, body: { message: 'The account has the identity shop.example.tn already' } });
    identities.create.mockRejectedValueOnce(new IdentityRefusal('limit', 'The Beta plan allows 2 domains to send mail from, and the account has 2: delete one first'));
    expect((await call('POST', '/email/identities', { identity: 'third.example.tn' })).status).toBe(400);
    expect(await call('POST', '/email/identities', { identity: 'shop.example.tn', dkimKey: 'mine' })).toMatchObject({ status: 400, body: { message: ['property dkimKey should not exist'] } });

    identities.find.mockResolvedValueOnce(null);
    expect(await call('GET', '/email/identities/Nothing.Example.TN')).toMatchObject({ status: 404, body: { message: 'The account has no identity nothing.example.tn' } });
    identities.remove.mockResolvedValueOnce(false);
    expect((await call('DELETE', '/email/identities/nothing.example.tn')).status).toBe(404);
    expect((await call('DELETE', '/email/identities/shop.example.tn')).status).toBe(204);
  });

  it('looks a domain up again on asking, and reads the account\'s sending', async () => {
    expect((await call('POST', '/email/identities/shop.example.tn/verify')).status).toBe(200);
    expect(identities.checkNow).toHaveBeenCalledWith({ accountId: ACCOUNT }, DOMAIN);
    expect(await call('GET', '/email/account')).toEqual({
      status: 200,
      body: { sandbox: true, sendingEnabled: true, enforcementStatus: 'HEALTHY', max24HourSend: 200, maxSendRate: 1, sentLast24Hours: 0 },
    });
  });

  it('keeps the suppression list: an address put there for a reason, a page of it, one taken off', async () => {
    expect(await call('PUT', '/email/suppressions/Gone@Example.TN', { reason: 'BOUNCE' })).toMatchObject({ status: 200, body: { address: 'gone@example.tn', reason: 'BOUNCE' } });
    expect(suppressions.put).toHaveBeenCalledWith({ accountId: ACCOUNT }, ACCOUNT, 'Gone@Example.TN', 'BOUNCE');
    expect(await call('PUT', '/email/suppressions/not-an-address', { reason: 'BOUNCE' })).toMatchObject({ status: 400, body: { message: expect.stringMatching(/^not-an-address is not an address: /) } });
    expect(await call('PUT', '/email/suppressions/gone@example.tn', { reason: 'SPAM' })).toMatchObject({ status: 400, body: { message: ['reason must be BOUNCE or COMPLAINT'] } });

    expect((await call('GET', '/email/suppressions?reason=COMPLAINT&limit=10')).status).toBe(200);
    expect(suppressions.list).toHaveBeenCalledWith(ACCOUNT, { reasons: ['COMPLAINT'], pageSize: 10, next: undefined });
    suppressions.list.mockResolvedValueOnce(null);
    expect(await call('GET', '/email/suppressions?next=nope')).toMatchObject({ status: 400, body: { message: 'next is no page of the list' } });
    expect((await call('GET', '/email/suppressions?limit=1001')).status).toBe(400);

    suppressions.remove.mockResolvedValueOnce(false);
    expect(await call('DELETE', '/email/suppressions/Gone@Example.TN')).toMatchObject({ status: 404, body: { message: "gone@example.tn is not on the account's suppression list" } });
  });

  it("sends a simple message for the caller's account, answering its ID", async () => {
    const sent = await call('POST', '/email/messages', { from: 'Shop <orders@shop.example.tn>', to: ['ana@shop.example.tn'], bcc: ['audit@shop.example.tn'], subject: 'Your order', text: 'Thanks' });

    expect(sent).toEqual({ status: 201, body: { messageId: MESSAGE.id } });
    expect(messages.send).toHaveBeenCalledWith(ACCOUNT, {
      from: 'Shop <orders@shop.example.tn>',
      to: ['ana@shop.example.tn'],
      cc: [],
      bcc: ['audit@shop.example.tn'],
      replyTo: [],
      content: { simple: { subject: 'Your order', text: 'Thanks', html: undefined, headers: [] } },
    });
  });

  it('refuses a body SendEmail would not take, before the service sees it', async () => {
    const message = { from: 'orders@shop.example.tn', to: ['ana@shop.example.tn'], subject: 'Hi', text: 'x' };

    expect((await call('POST', '/email/messages', { ...message, to: [] })).status).toBe(400);
    expect((await call('POST', '/email/messages', { ...message, to: Array.from({ length: 51 }, (_, n) => `a${n}@shop.example.tn`) })).status).toBe(400);
    expect((await call('POST', '/email/messages', { ...message, subject: undefined })).status).toBe(400);
    expect(await call('POST', '/email/messages', { ...message, headers: [{ name: 'X-Ff', value: '1' }] })).toMatchObject({ status: 400, body: { message: ['property headers should not exist'] } });
    expect(messages.send).not.toHaveBeenCalled();
  });

  it("answers the service's refusals each with its status, in SES's words", async () => {
    const message = { from: 'orders@shop.example.tn', to: ['ana@shop.example.tn'], subject: 'Hi', text: 'x' };
    const statuses: Record<SendRefusalKind, number> = { invalid: 400, rejected: 400, paused: 403, suspended: 403, daily: 429, rate: 429, unavailable: 503 };

    for (const [kind, status] of Object.entries(statuses) as Array<[SendRefusalKind, number]>) {
      messages.send.mockRejectedValueOnce(new SendRefusal(kind, `refused: ${kind}`));
      expect(await call('POST', '/email/messages', message)).toMatchObject({ status, body: { message: `refused: ${kind}` } });
    }
  });

  it("lists the account's latest messages, each recipient's fate, never the message's copy nor its return path", async () => {
    const listed = await call('GET', '/email/messages?limit=10');

    expect(listed).toEqual({
      status: 200,
      body: {
        messages: [
          {
            messageId: MESSAGE.id,
            from: 'orders@shop.example.tn',
            identity: 'shop.example.tn',
            status: 'SENT',
            recipients: [
              { address: 'ana@shop.example.tn', status: 'SENT', diagnostic: null },
              { address: 'gone@shop.example.tn', status: 'BOUNCED', diagnostic: 'smtp; 550 5.1.1 User unknown' },
            ],
            sizeBytes: 812,
            createdAt: AT.toISOString(),
            sentAt: AT.toISOString(),
          },
        ],
      },
    });
    expect(messages.latest).toHaveBeenCalledWith(ACCOUNT, 10);
    await call('GET', '/email/messages');
    expect(messages.latest).toHaveBeenLastCalledWith(ACCOUNT, 50);
    expect((await call('GET', '/email/messages?limit=101')).status).toBe(400);
  });
});
