/**
 * L1: PATCH /me through HTTP, with the validation main.ts sets up: a user
 * changes the language of their own e-mails, to French or English only, and
 * only with a login. Storing it runs against PostgreSQL in
 * accounts.service.db.spec.ts.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ROLES, SCOPE } from '../auth/route-rules';
import { AccountsController } from './accounts.controller';
import { AccountsService } from './accounts.service';
import { User } from './entities/user.entity';

const USER = { id: '8f06076e-1eba-422d-a1df-febf69d73341', email: 'amira@ff.tn', name: 'Amira', locale: 'fr-TN' } as User;

describe('PATCH /me (L1)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const updateMe = jest.fn(async (user: User, dto: { locale: string }) => ({ user: { ...user, locale: dto.locale }, accounts: [] }));

  const patch = (body: object, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/me`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountsController],
      providers: [{ provide: AccountsService, useValue: { updateMe } }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // As the guard does with a token; development mode has no user.
    app.use((req: { user?: User; headers: Record<string, string> }, _res: unknown, next: () => void) => {
      if (req.headers['x-test-mode'] !== 'dev') req.user = USER;
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true })); // as main.ts
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it("is any user's, for their own settings, and never an API key's: it names no scope", () => {
    const handler = AccountsController.prototype.updateMe;
    expect([new Reflector().get(ROLES, handler), new Reflector().get(SCOPE, handler)]).toEqual([undefined, undefined]);
  });

  it("changes the logged-in user's language, to English or back to French, and answers as GET /me", async () => {
    for (const locale of ['en', 'fr-TN']) {
      const res = await patch({ locale });
      expect([res.status, (await res.json()).user.locale]).toEqual([200, locale]);
      expect(updateMe).toHaveBeenLastCalledWith(USER, { locale });
    }
  });

  it('refuses another language, none, and a field it has no use for', async () => {
    for (const body of [{ locale: 'de' }, { locale: 'fr' }, { locale: 'EN' }, {}]) {
      const res = await patch(body);
      expect([res.status, (await res.json()).message]).toEqual([400, ['locale must be one of fr-TN, en']]);
    }
    const res = await patch({ locale: 'en', email: 'other@ff.tn' });
    expect([res.status, (await res.json()).message]).toEqual([400, ['property email should not exist']]);
    expect(updateMe).not.toHaveBeenCalled();
  });

  it('needs a login: development mode acts without a user', async () => {
    const res = await patch({ locale: 'en' }, { 'x-test-mode': 'dev' });
    expect([res.status, (await res.json()).message]).toEqual([400, 'Development mode acts as FF_DEV_ACCOUNT_ID, without a user: log in to manage accounts']);
    expect(updateMe).not.toHaveBeenCalled();
  });
});
