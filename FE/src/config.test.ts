import { describe, expect, it } from 'vitest';
import { consoleConfig } from './config';

describe('consoleConfig', () => {
  it('defaults to the local API and development mode, without a login', () => {
    expect(consoleConfig({})).toEqual({ apiUrl: 'http://localhost:3000', oidc: null });
  });

  it("reads the API's address without a trailing slash, which would double every route's", () => {
    expect(consoleConfig({ VITE_API_URL: ' https://api.ff.example/ ' }).apiUrl).toBe('https://api.ff.example');
  });

  it('logs in through the realm it names, as the ff-console client unless told otherwise', () => {
    expect(consoleConfig({ VITE_OIDC_AUTHORITY: 'http://localhost:8180/realms/ff/' }).oidc).toEqual({
      authority: 'http://localhost:8180/realms/ff',
      clientId: 'ff-console',
    });
    expect(consoleConfig({ VITE_OIDC_AUTHORITY: 'https://auth.ff.example/realms/ff', VITE_OIDC_CLIENT_ID: 'console' }).oidc).toEqual({
      authority: 'https://auth.ff.example/realms/ff',
      clientId: 'console',
    });
  });

  it('takes an empty or blank authority as development mode, as .env.example leaves it', () => {
    expect(consoleConfig({ VITE_OIDC_AUTHORITY: '' }).oidc).toBeNull();
    expect(consoleConfig({ VITE_OIDC_AUTHORITY: '   ' }).oidc).toBeNull();
  });
});
