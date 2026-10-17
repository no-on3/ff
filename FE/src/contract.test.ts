import { describe, expect, it } from 'vitest';
import corsSource from '../../BE/src/config/configuration.ts?raw';
import backendEnvExample from '../../BE/.env.example?raw';
import scopesSource from '../../BE/src/api-keys/api-key-format.ts?raw';
import planLimitsSource from '../../BE/src/plans/plan-limits.ts?raw';
import invocationSource from '../../BE/src/functions/entities/function-invocation.entity.ts?raw';
import usageDtoSource from '../../BE/src/usage/usage.dto.ts?raw';
import realmSource from '../../deploy/keycloak/ff-realm.json?raw';
import viteConfigSource from '../vite.config.ts?raw';
import { LOGGED_OUT_PATH, oidcSettings } from './auth/oidc';
import { PLAN_LIMIT_KEYS } from './lib/plans';
import { INVOCATION_STATUSES, SCOPES, USAGE_AMOUNTS } from './services/api';

// What the console shares with the API and the development realm, read from
// their files: a console on another port than the realm and the API allow
// can't log in, and the browser blocks its calls (P-14).

const port = /const CONSOLE_PORT = (\d+)/.exec(viteConfigSource)?.[1];
const origin = `http://localhost:${port}`;

interface RealmClient {
  clientId: string;
  publicClient: boolean;
  standardFlowEnabled: boolean;
  redirectUris: string[];
  webOrigins: string[];
  attributes: Record<string, string>;
  protocolMappers: { protocolMapper: string; config: Record<string, string> }[];
}
const consoleClient = (JSON.parse(realmSource) as { clients: RealmClient[] }).clients.find((c) => c.clientId === 'ff-console')!;

/** Keycloak's rule: a registered URI ending in * allows every URI it starts. */
const allows = (registered: string[], uri: string) =>
  registered.some((pattern) => (pattern.endsWith('*') ? uri.startsWith(pattern.slice(0, -1)) : uri === pattern));

describe("the console's address", () => {
  it('is fixed in the Vite config', () => {
    expect(port).toBe('5199');
    expect(viteConfigSource).toContain('strictPort: true');
  });

  it('is where the development realm lets ff-console come back after login and logout', () => {
    const settings = oidcSettings({ authority: 'http://localhost:8180/realms/ff', clientId: 'ff-console' }, origin);

    expect(allows(consoleClient.redirectUris, settings.redirect_uri)).toBe(true);
    expect(allows(consoleClient.attributes['post.logout.redirect.uris'].split('##'), settings.post_logout_redirect_uri!)).toBe(true);
    expect(settings.post_logout_redirect_uri).toBe(`${origin}${LOGGED_OUT_PATH}`);
    expect(consoleClient.webOrigins).toContain(origin); // the token request is a cross-origin call
  });

  it("is the backend's CORS origin in development, by default and in BE/.env.example", () => {
    expect(corsSource).toContain(`const DEV_CORS_ORIGIN = '${origin}';`);
    expect(backendEnvExample).toMatch(new RegExp(`^CORS_ORIGIN=${origin}$`, 'm'));
  });
});

describe("the development realm's ff-console client", () => {
  it('is a public client with the code flow and PKCE, as a browser app must be', () => {
    expect(consoleClient).toMatchObject({ publicClient: true, standardFlowEnabled: true });
    expect(consoleClient.attributes['pkce.code.challenge.method']).toBe('S256');
  });

  it('puts the API in its tokens\' audience, which the API checks', () => {
    expect(consoleClient.protocolMappers).toContainEqual(
      expect.objectContaining({ protocolMapper: 'oidc-audience-mapper', config: expect.objectContaining({ 'included.custom.audience': 'ff-api' }) }),
    );
  });
});

describe('API key scopes', () => {
  it("are the API's, so the form offers each one it accepts", () => {
    const backendScopes = /export const SCOPES = \[([^\]]*)\] as const/.exec(scopesSource)?.[1].match(/'[^']+'/g)?.map((s) => s.slice(1, -1));

    expect(backendScopes).toEqual([...SCOPES]);
  });
});

describe("an invocation's status", () => {
  it("is one of the API's, so the history has a style for each one it may show (P-20 added LOST)", () => {
    const enumBody = invocationSource.slice(invocationSource.indexOf('export enum InvocationStatus'));
    const backendStatuses = [...enumBody.slice(0, enumBody.indexOf('\n}')).matchAll(/^ {2}\w+ = '(\w+)',$/gm)].map((match) => match[1]);

    expect(backendStatuses).toContain('LOST');
    expect(backendStatuses).toEqual([...INVOCATION_STATUSES]);
  });
});

describe('the usage of a month (P-22)', () => {
  it("has the API's amounts, so the page shows each one and reads none that isn't there", () => {
    const body = usageDtoSource.slice(usageDtoSource.indexOf('export class UsageAmountsView {'));
    const backendAmounts = [...body.slice(0, body.indexOf('\n}')).matchAll(/^ {2}(\w+): /gm)].map((match) => match[1]);

    expect(backendAmounts).toEqual([...USAGE_AMOUNTS]);
  });
});

describe("a plan's limits", () => {
  it("have the API's names, so the console shows each one and reads none that isn't there", () => {
    const schema = planLimitsSource.slice(planLimitsSource.indexOf('export const planLimitsSchema'));
    const body = schema.slice(schema.indexOf('{') + 1, schema.indexOf('\n});'));
    const backendKeys = [...body.matchAll(/^ {2}(\w+):/gm)].map((match) => match[1]);

    expect(backendKeys).toEqual([...PLAN_LIMIT_KEYS]);
  });
});
