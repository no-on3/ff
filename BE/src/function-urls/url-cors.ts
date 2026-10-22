import type { UrlCors } from '../functions/entities/function-url.entity';

/**
 * A function URL's CORS, as AWS Lambda applies it: with a configuration, the
 * URL answers a browser's preflight itself, and adds its headers to every
 * answer, in place of any the function sends; without one, it adds nothing,
 * and a preflight is a request like any other, for the function to answer.
 */

/** A browser's preflight: OPTIONS, from an origin, asking for a method. */
export function isPreflight(method: string, headers: Record<string, string | string[] | undefined>): boolean {
  return method === 'OPTIONS' && headers.origin !== undefined && headers['access-control-request-method'] !== undefined;
}

/** Whether the configuration lets this origin in: one of its origins, compared without case, or "*". */
export function allowsOrigin(cors: UrlCors, origin: string | undefined): origin is string {
  if (!origin) return false;
  const origins = cors.allowOrigins ?? [];
  return origins.includes('*') || origins.some((allowed) => allowed.toLowerCase() === origin.toLowerCase());
}

/** The origin an answer names: "*" when any origin may read it without credentials, else the caller's own, which then varies. */
function originHeaders(cors: UrlCors, origin: string): Array<[string, string]> {
  if ((cors.allowOrigins ?? []).includes('*') && !cors.allowCredentials) return [['access-control-allow-origin', '*']];
  return [
    ['access-control-allow-origin', origin],
    ['vary', 'Origin'],
  ];
}

/** What a preflight is answered with: the configuration's, for an origin it lets in; nothing for another, which the browser then refuses. */
export function preflightHeaders(cors: UrlCors, origin: string | undefined): Array<[string, string]> {
  if (!allowsOrigin(cors, origin)) return [];
  return [
    ...originHeaders(cors, origin),
    ...(cors.allowMethods?.length ? [['access-control-allow-methods', cors.allowMethods.join(',')] as [string, string]] : []),
    ...(cors.allowHeaders?.length ? [['access-control-allow-headers', cors.allowHeaders.join(',')] as [string, string]] : []),
    ...(cors.allowCredentials ? [['access-control-allow-credentials', 'true'] as [string, string]] : []),
    ...(cors.maxAge !== undefined ? [['access-control-max-age', String(cors.maxAge)] as [string, string]] : []),
  ];
}

/** What an answer to an origin it lets in carries: the origin, the headers it may read, and credentials. */
export function responseCorsHeaders(cors: UrlCors, origin: string | undefined): Array<[string, string]> {
  if (!allowsOrigin(cors, origin)) return [];
  return [
    ...originHeaders(cors, origin),
    ...(cors.exposeHeaders?.length ? [['access-control-expose-headers', cors.exposeHeaders.join(',')] as [string, string]] : []),
    ...(cors.allowCredentials ? [['access-control-allow-credentials', 'true'] as [string, string]] : []),
  ];
}

/** The function's own CORS headers, which a configuration replaces. */
export const isCorsHeader = (name: string): boolean => name.toLowerCase().startsWith('access-control-');
