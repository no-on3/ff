/**
 * L1: an account's sending for FF's operators (ADR 0012) through HTTP, with the
 * validation main.ts sets up: what each route passes to the service, and what
 * each refuses; and the e-mail its owners get of a change, in both languages.
 * The service runs against PostgreSQL in admin-email.db.spec.ts; who may call
 * them is the guard's (auth.guard.spec.ts).
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AdminEmailController } from './admin-email.controller';
import { AdminEmailService, sendingMail } from './admin-email.service';
import { IS_ADMIN } from './operator';

const ID = '000000000042';
const VIEW = { sandbox: true, sendingEnabled: true, enforcementStatus: 'HEALTHY', max24HourSend: 200, maxSendRate: 1, sentLast24Hours: 3, reason: null, updatedAt: null, identities: [] };
const ACCOUNT = { id: ID, name: 'Tunis Labs' };
const HEALTHY = { productionAccess: false, sendingEnabled: true, enforcementStatus: 'HEALTHY' as const };

describe("an account's sending, for operators (L1)", () => {
  let app: INestApplication;
  let baseUrl: string;
  const email = { view: jest.fn(async () => VIEW), change: jest.fn(async () => VIEW) };
  const call = (method: string, path: string, body?: object) =>
    fetch(`${baseUrl}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const refusal = async (res: Response) => [res.status, ((await res.json()) as { message: unknown }).message];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [AdminEmailController], providers: [{ provide: AdminEmailService, useValue: email }] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("are the admin dashboard's routes: operators only", () => {
    expect(new Reflector().get(IS_ADMIN, AdminEmailController)).toBe(true);
  });

  it("GET /admin/accounts/:id/email reads the account's sending", async () => {
    const res = await call('GET', `/admin/accounts/${ID}/email`);

    expect([res.status, await res.json()]).toEqual([200, VIEW]);
    expect(email.view).toHaveBeenCalledWith(ID);
  });

  it('PUT /admin/accounts/:id/email passes the changes named, with the reason', async () => {
    const res = await call('PUT', `/admin/accounts/${ID}/email`, { productionAccess: true, reason: 'Sends its receipts, checked with the owner' });

    expect(res.status).toBe(200);
    expect(email.change).toHaveBeenCalledWith(ID, { productionAccess: true, sendingEnabled: undefined, enforcementStatus: undefined }, 'Sends its receipts, checked with the owner');
  });

  it('refuses no change, a change that is not one of the three, and no reason', async () => {
    expect(await refusal(await call('PUT', `/admin/accounts/${ID}/email`, { reason: 'Nothing to change at all' }))).toEqual([
      400,
      'Name a change: productionAccess, sendingEnabled or enforcementStatus',
    ]);
    expect(await refusal(await call('PUT', `/admin/accounts/${ID}/email`, { enforcementStatus: 'BANNED', reason: 'Spam seen by a provider' }))).toEqual([
      400,
      ['enforcementStatus must be HEALTHY, PROBATION or SHUTDOWN'],
    ]);
    expect((await call('PUT', `/admin/accounts/${ID}/email`, { sendingEnabled: 'no', reason: 'Spam seen by a provider' })).status).toBe(400);
    expect((await call('PUT', `/admin/accounts/${ID}/email`, { sendingEnabled: false })).status).toBe(400);
    expect((await call('PUT', '/admin/accounts/not-an-id/email', { sendingEnabled: false, reason: 'Spam seen by a provider' })).status).toBe(400);
    expect(email.change).not.toHaveBeenCalled();
  });

  describe("the e-mail to the account's owners", () => {
    it('says each change, the reason, and where the console shows it, in English', () => {
      const mail = sendingMail(ACCOUNT, HEALTHY, { productionAccess: true, sendingEnabled: false, enforcementStatus: 'HEALTHY' }, 'Spam seen by a provider', 'https://console.ff.test', 'en');

      expect(mail).toEqual({
        subject: "Your FF account's mail: Tunis Labs",
        text: [
          `FF changed the sending of your account "Tunis Labs" (${ID}):`,
          "Your account is out of the sandbox: its mail may go to any address, within its plan's quotas.",
          "FF paused your account's sending: the SES endpoint refuses its messages (SendingPausedException).",
          'Why: Spam seen by a provider',
          '',
          'The console: https://console.ff.test/email',
        ].join('\n'),
      });
    });

    it('says the same in French, and only what changed', () => {
      const mail = sendingMail(ACCOUNT, { ...HEALTHY, productionAccess: true, enforcementStatus: 'SHUTDOWN' }, { ...HEALTHY, enforcementStatus: 'HEALTHY' }, 'Revu avec le client', 'https://console.ff.test', 'fr');

      expect(mail).toEqual({
        subject: 'Le courrier de votre compte FF : Tunis Labs',
        text: [
          `FF a modifié l'envoi de courrier de votre compte « Tunis Labs » (${ID}) :`,
          "Votre compte revient dans le bac à sable : son courrier ne va plus qu'aux adresses et domaines qu'il a prouvés.",
          "L'état de votre courrier, après examen de ses rebonds et plaintes, est maintenant HEALTHY.",
          'Motif : Revu avec le client',
          '',
          'La console : https://console.ff.test/email',
        ].join('\n'),
      });
    });
  });
});
