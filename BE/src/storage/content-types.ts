/**
 * The content type a site's file gets by its name, when the store has none of
 * its own for it: what a built site holds, as web servers name them. The `ff`
 * command uploads each file with the same types (cli/src/commands/sites.rs,
 * whose tests read this list).
 */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  webmanifest: 'application/manifest+json',
  xml: 'application/xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  zip: 'application/zip',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

/** What a store gives an object uploaded without a type: the file's name says more. */
const UNTYPED = new Set(['', 'binary/octet-stream', 'application/octet-stream']);

/** A file's type by its name's extension; application/octet-stream for one not listed, as browsers then download it. */
export function contentTypeOf(key: string): string {
  const name = key.slice(key.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return (dot > 0 && CONTENT_TYPES[name.slice(dot + 1).toLowerCase()]) || 'application/octet-stream';
}

/** The type a site answers a file with: the one it was uploaded with, else the one its name gives. */
export function servedContentType(stored: string | undefined, key: string): string {
  return stored === undefined || UNTYPED.has(stored.split(';')[0].trim().toLowerCase()) ? contentTypeOf(key) : stored;
}
