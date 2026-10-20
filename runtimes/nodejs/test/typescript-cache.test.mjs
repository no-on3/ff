// L1 tests for the TypeScript compiler's code cache (src/typescript-cache.ts), which the image writes at its build
// so that a cold start at 0.1 CPU doesn't spend most of its 10 s limit compiling the compiler. Each case loads the
// compiler in a process of its own, as a cold start does: within one process V8 reuses what it compiled already,
// and never reads a cache. Run: npm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const dist = path.resolve(import.meta.dirname, '../dist');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-typescript-cache-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const source = 'enum Level { Low = 1 }\nexport const level = (given?: number): number => given ?? Level.Low;\n';

/** Runs `body` in a new Node.js process, with the runtime's modules as `cache` and `hook`; returns what it prints. */
function inNewProcess(body) {
  const script = `const cache = require(${JSON.stringify(`${dist}/typescript-cache.js`)});
const hook = require(${JSON.stringify(`${dist}/ts-hook.js`)});
const source = ${JSON.stringify(source)};
console.log(JSON.stringify((() => { ${body} })()));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
}

describe("the TypeScript compiler's code cache", () => {
  const cache = path.join(dir, 'typescript.codecache');
  inNewProcess(`hook.writeTypeScriptCache(${JSON.stringify(cache)}); return null;`);

  it('is taken by V8, and its compiler transpiles exactly as one compiled without it', () => {
    const fromCache = inNewProcess(`const { ts, cached } = cache.loadTypeScript(${JSON.stringify(cache)});
return { cached, output: hook.transpile(ts, source, 'level.ts') };`);
    const without = inNewProcess(`return hook.transpile(cache.compileTypeScript().ts, source, 'level.ts');`);

    assert.deepEqual(fromCache, { cached: true, output: without });
  });

  // Node.js's own compile cache keeps only what loading compiles, which saved the load but left the first
  // transpile, the longer half inside gVisor.
  it('holds the code a transpile runs, not only what loading the compiler compiles', () => {
    const loadedOnly = inNewProcess('return cache.compileTypeScript().script.createCachedData().length;');
    const size = fs.statSync(cache).size;

    assert.ok(size > loadedOnly * 1.2, `${size} bytes, against ${loadedOnly} for the load alone`);
  });

  it('only speeds the start up: missing, or refused by V8, the compiler is compiled as usual', () => {
    fs.writeFileSync(path.join(dir, 'other'), Buffer.alloc(4096, 7)); // as if made by another Node.js version

    for (const file of [path.join(dir, 'missing'), path.join(dir, 'other')]) {
      const { cached, output } = inNewProcess(`const { ts, cached } = cache.loadTypeScript(${JSON.stringify(file)});
return { cached, output: hook.transpile(ts, source, 'level.ts') };`);
      assert.equal(cached, false, file);
      assert.match(output, /exports\.level = level;/);
    }
  });
});
