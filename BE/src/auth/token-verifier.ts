import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, errors, JWTPayload, jwtVerify, JWTVerifyGetKey } from 'jose';

/** Who a valid access token says the caller is (D2). */
export interface Identity {
  /** The token's subject: Keycloak's user ID. */
  userId: string;
  email?: string;
  /** The user's full name, as Keycloak's profile has it. */
  name?: string;
  /** The client the token was issued to (azp): ff-console, ff-admin, … (D12). */
  clientId?: string;
  /** The user's realm roles, such as ff-operator (D12). */
  realmRoles?: string[];
}

/** Asymmetric algorithms only: "none" and the HMAC ones (HS*) are refused (ADR 0004). */
export const ACCEPTED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

/** How far the token's clock may be from ours. */
const CLOCK_TOLERANCE_SECONDS = 30;

/** The token can't be trusted: the caller isn't authenticated (401). */
export class InvalidTokenError extends Error {
  readonly name = 'InvalidTokenError';
}

/** The token is valid, but its user hasn't verified their e-mail address (403). */
export class UnverifiedEmailError extends Error {
  readonly name = 'UnverifiedEmailError';
}

/** jose's errors about the token itself. Any other failure (the realm's keys can't be read) is the platform's. */
const TOKEN_ERRORS = new Set([
  'ERR_JWT_EXPIRED',
  'ERR_JWT_CLAIM_VALIDATION_FAILED',
  'ERR_JWT_INVALID',
  'ERR_JWS_INVALID',
  'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JOSE_ALG_NOT_ALLOWED',
  'ERR_JOSE_NOT_SUPPORTED',
  'ERR_JWKS_NO_MATCHING_KEY',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
]);

function invalidToken(error: errors.JOSEError): InvalidTokenError {
  if (error instanceof errors.JWTExpired) return new InvalidTokenError('The token has expired');
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === 'iss') return new InvalidTokenError('The token was issued by another issuer');
    if (error.claim === 'aud') return new InvalidTokenError('The token is not meant for this API');
    if (error.claim === 'nbf') return new InvalidTokenError('The token is not valid yet');
  }
  return new InvalidTokenError('The token is invalid');
}

/**
 * Checks access tokens from the realm (D2): the signature against the realm's
 * keys, an asymmetric algorithm, the issuer, the API's audience, the expiry,
 * a subject, and a verified e-mail address.
 */
@Injectable()
export class TokenVerifier {
  /**
   * After reading the realm's keys, how long a token naming a key it lacks is
   * refused without reading them again: forged key IDs can't make the backend
   * hammer the realm. A rotated key is picked up after this, at the latest.
   */
  keyRefetchCooldownMs = 30_000;

  private keys?: Promise<JWTVerifyGetKey>;

  constructor(private readonly config: ConfigService) {}

  async verify(token: string): Promise<Identity> {
    const { issuer, audience } = this.config.getOrThrow<{ issuer: string; audience: string }>('auth.oidc');
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, await this.keySet(issuer), {
        issuer,
        audience,
        algorithms: ACCEPTED_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      }));
    } catch (error) {
      if (error instanceof errors.JOSEError && TOKEN_ERRORS.has(error.code)) throw invalidToken(error);
      throw error;
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') throw new InvalidTokenError('The token has no valid subject');
    if (payload.email_verified !== true) throw new UnverifiedEmailError('Verify your e-mail address first');
    const roles = (payload.realm_access as { roles?: unknown } | undefined)?.roles;
    return {
      userId: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      clientId: typeof payload.azp === 'string' ? payload.azp : undefined,
      realmRoles: Array.isArray(roles) ? roles.filter((role): role is string => typeof role === 'string') : undefined,
    };
  }

  /**
   * The realm's public keys, found through its OpenID configuration. jose
   * caches them, and fetches them again when a token names a key it doesn't
   * have, once keyRefetchCooldownMs has passed. A failed discovery is tried
   * again next time.
   */
  private keySet(issuer: string): Promise<JWTVerifyGetKey> {
    if (!this.keys) {
      const keys = discoverJwksUri(issuer).then((uri) =>
        createRemoteJWKSet(new URL(uri), {
          cooldownDuration: this.keyRefetchCooldownMs,
          cacheMaxAge: 10 * 60_000,
          timeoutDuration: 5_000,
        }),
      );
      keys.catch(() => {
        if (this.keys === keys) this.keys = undefined;
      });
      this.keys = keys;
    }
    return this.keys;
  }
}

/** Where the realm publishes its keys, from its OpenID configuration, which must name the same issuer. */
async function discoverJwksUri(issuer: string): Promise<string> {
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!res.ok) throw new Error(`OpenID configuration ${url} answered HTTP ${res.status}`);
  const configuration = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
  if (configuration.issuer !== issuer) {
    throw new Error(`OpenID configuration ${url} names the issuer ${String(configuration.issuer)}, not ${issuer}`);
  }
  if (typeof configuration.jwks_uri !== 'string') throw new Error(`OpenID configuration ${url} has no jwks_uri`);
  return configuration.jwks_uri;
}
