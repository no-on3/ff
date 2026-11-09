import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { LoginController } from './login.controller';
import { IS_PUBLIC } from './public.decorator';

const controller = (auth: object) => new LoginController(new ConfigService({ auth }));

describe('where to log in (GET /login)', () => {
  it("names the realm's issuer, as tokens name it, when the API checks tokens", () => {
    const settings = controller({ mode: 'oidc', oidc: { issuer: 'https://login.ff.example/realms/ff', audience: 'ff-api', jwksUrl: 'http://keycloak:8080/realms/ff/protocol/openid-connect/certs' } }).settings();

    // The issuer alone: the address the backend reaches the keys at inside the cluster stays inside it.
    expect(settings).toEqual({ mode: 'oidc', issuer: 'https://login.ff.example/realms/ff' });
  });

  it('says there is no login in development mode', () => {
    expect(controller({ mode: 'dev', devAccountId: '000000000001' }).settings()).toEqual({ mode: 'dev' });
  });

  it('answers without a token, since a client asks it before it has one', () => {
    expect(new Reflector().get(IS_PUBLIC, LoginController.prototype.settings)).toBe(true);
  });
});
