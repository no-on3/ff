import { describe, expect, it } from 'vitest';
import { adminConfig } from './config';

describe('adminConfig', () => {
  it('reads the API and the realm, with ff-admin as the client', () => {
    expect(adminConfig({ VITE_API_URL: 'https://api.ff.example/', VITE_OIDC_AUTHORITY: ' https://login.ff.example/realms/ff/ ' })).toEqual({
      apiUrl: 'https://api.ff.example',
      oidc: { authority: 'https://login.ff.example/realms/ff', clientId: 'ff-admin' },
    });
  });

  it('has no development mode: without a realm, it says what is missing', () => {
    expect(adminConfig({})).toEqual({
      problem: 'VITE_OIDC_AUTHORITY is not set: the admin dashboard needs the realm operators log in with (see admin/.env.example).',
    });
  });
});
