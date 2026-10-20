/**
 * Loads the TypeScript compiler, about 9 MB of JavaScript, with a V8 code
 * cache that the image keeps for it (Dockerfile). At the smallest size, 0.1
 * CPU, inside gVisor, compiling the compiler and then the functions its first
 * transpile runs took 7 to 10 s of a cold start, against the 10 s start-up
 * limit; read from this cache, about 2.5 s. The cache is written after a
 * transpile has run, so it holds those functions too: Node.js's own compile
 * cache keeps only what a module's first run compiles, which saved the load
 * but not the transpile. Without the cache, or when V8 refuses it (made by
 * another Node.js version), the compiler is compiled as usual, only slower.
 */
import * as fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import * as path from 'node:path';
import * as vm from 'node:vm';
import type * as TypeScript from 'typescript';

const FILE = require.resolve('typescript');
/** Where the image keeps the cache: next to the runtime's compiled files. */
export const CODE_CACHE = path.join(__dirname, '..', 'typescript.codecache');

/** CommonJS's module wrapper. V8 takes a cache only for the very source it was made from. */
const wrap = (source: string) => `(function (exports, require, module, __filename, __dirname) { ${source}\n});`;

/**
 * Compiles and runs the compiler's module, with the cache's code when V8 takes it. The module goes in require's
 * cache, as require() would put it: anything that requires TypeScript after this gets the same one.
 */
export function compileTypeScript(cachedData?: Buffer): { ts: typeof TypeScript; script: vm.Script } {
  const script = new vm.Script(wrap(fs.readFileSync(FILE, 'utf8')), { filename: FILE, cachedData });
  const module = new Module(FILE);
  module.filename = FILE;
  const run = script.runInThisContext() as (...args: unknown[]) => void;
  run(module.exports, createRequire(FILE), module, FILE, path.dirname(FILE));
  module.loaded = true;
  require.cache[FILE] = module;
  return { ts: module.exports as typeof TypeScript, script };
}

/** The compiler, and whether it came from the cache. */
export function loadTypeScript(cacheFile = CODE_CACHE): { ts: typeof TypeScript; cached: boolean } {
  let cachedData: Buffer | undefined;
  try {
    cachedData = fs.readFileSync(cacheFile);
  } catch {
    // no cache: compiled as usual
  }
  const { ts, script } = compileTypeScript(cachedData);
  // V8 says false only when it was given a cache and took it.
  return { ts, cached: script.cachedDataRejected === false };
}

/** Writes the cache once `warmUp` has run the compiler, at the image's build. */
export function writeCodeCache(warmUp: (ts: typeof TypeScript) => void, cacheFile = CODE_CACHE): void {
  const { ts, script } = compileTypeScript();
  warmUp(ts);
  fs.writeFileSync(cacheFile, script.createCachedData());
}
