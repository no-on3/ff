import { describe, expect, it } from 'vitest';
import corsSource from '../../BE/src/config/configuration.ts?raw';
import backendEnvExample from '../../BE/.env.example?raw';
import scopesSource from '../../BE/src/api-keys/api-key-format.ts?raw';
import realmSource from '../../deploy/keycloak/ff-realm.json?raw';
import viteConfigSource from '../vite.config.ts?raw';
import { LOGGED_OUT_PATH, oidcSettings } from './auth/oidc';
import { SCOPES } from './services/api';

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
