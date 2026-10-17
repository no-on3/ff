import { describe, expect, it } from 'vitest';
import configurationSource from '../../BE/src/config/configuration.ts?raw';
import backendEnvExample from '../../BE/.env.example?raw';
import operatorSource from '../../BE/src/admin/operator.ts?raw';
import settingsSource from '../../BE/src/admin/platform-settings.ts?raw';
import realmSource from '../../deploy/keycloak/ff-realm.json?raw';
import viteConfigSource from '../vite.config.ts?raw';
import { DEFAULT_OIDC_CLIENT_ID } from './config';
import { REASON_LENGTH } from './lib/reason';
import { SETTINGS } from './lib/settings';

// What the admin dashboard shares with the API and the development realm, read from their files (P-70, D12).

const port = /const ADMIN_PORT = (\d+)/.exec(viteConfigSource)?.[1];
const origin = `http://localhost:${port}`;
const constant = (name: string) => new RegExp(`export const ${name} = '([^']+)'`).exec(operatorSource)?.[1];

interface Execution {
  authenticator?: string;
  requirement: string;
  flowAlias?: string;
  authenticatorConfig?: string;
}
const realm = JSON.parse(realmSource) as {
  browserFlow: string;
  roles: { realm: Array<{ name: string }> };
  clients: Array<{ clientId: string; publicClient: boolean; standardFlowEnabled: boolean; redirectUris: string[]; webOrigins: string[]; attributes: Record<string, string>; protocolMappers: Array<{ config: Record<string, string> }> }>;
  authenticationFlows: Array<{ alias: string; authenticationExecutions: Execution[] }>;
  authenticatorConfig: Array<{ alias: string; config: Record<string, string> }>;
};
const flow = (alias: string) => realm.authenticationFlows.find((f) => f.alias === alias)!;

describe("the admin dashboard's address", () => {
  it('is fixed at 5198, and the backend links to it and lets it call the API in development', () => {
    expect(port).toBe('5198');
    expect(viteConfigSource).toContain('strictPort: true');
    expect(configurationSource).toContain(`const DEV_ADMIN_URL = '${origin}';`);
    expect(configurationSource).toContain('[DEV_CORS_ORIGIN, DEV_ADMIN_URL]');
    expect(backendEnvExample).toMatch(new RegExp(`^FF_ADMIN_URL=${origin}$`, 'm'));
    expect(backendEnvExample).toMatch(new RegExp(`^CORS_ORIGIN=.*\\b${origin}\\b`, 'm'));
  });
});

describe("the development realm's ff-admin client and ff-operator role", () => {
  const admin = realm.clients.find((c) => c.clientId === DEFAULT_OIDC_CLIENT_ID)!;

  it('are the ones the backend checks', () => {
    expect(constant('ADMIN_CLIENT')).toBe(DEFAULT_OIDC_CLIENT_ID);
    expect(realm.roles.realm.map((r) => r.name)).toContain(constant('OPERATOR_ROLE'));
  });

  it('logs in a browser at the dashboard with the code flow and PKCE, and its tokens are for the API', () => {
    expect(admin).toMatchObject({ publicClient: true, standardFlowEnabled: true });
    expect(admin.attributes['pkce.code.challenge.method']).toBe('S256');
    expect(admin.redirectUris).toContain(`${origin}/*`);
    expect(admin.attributes['post.logout.redirect.uris']).toBe(`${origin}/*`);
    expect(admin.webOrigins).toContain(origin);
    expect(admin.protocolMappers.map((m) => m.config['included.custom.audience'])).toContain('ff-api');
  });

  it('asks operators, and only them, for a one-time password at login', () => {
    const top = flow(realm.browserFlow);
    const forms = flow(top.authenticationExecutions.find((e) => e.flowAlias)!.flowAlias!);
    const otp = forms.authenticationExecutions.find((e) => e.requirement === 'CONDITIONAL')!;
    const steps = flow(otp.flowAlias!).authenticationExecutions;
    const condition = realm.authenticatorConfig.find((c) => c.alias === steps[0].authenticatorConfig)!;

    expect(steps.map((s) => [s.authenticator, s.requirement])).toEqual([
      ['conditional-user-role', 'REQUIRED'],
      ['auth-otp-form', 'REQUIRED'],
    ]);
    expect(condition.config).toEqual({ condUserRole: constant('OPERATOR_ROLE'), negate: 'false' });
  });
});

describe('the platform settings and the reason', () => {
  it("are the API's: the same settings, and the same rule for a reason", () => {
    const defaults = settingsSource.slice(settingsSource.indexOf('export const DEFAULT_SETTINGS'));
    const keys = [...defaults.slice(0, defaults.indexOf('\n};')).matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]);

    expect(SETTINGS.map((s) => s.key)).toEqual(keys);
    expect(operatorSource).toContain(`export const REASON_LENGTH = { min: ${REASON_LENGTH.min}, max: ${REASON_LENGTH.max} } as const;`);
  });
});
