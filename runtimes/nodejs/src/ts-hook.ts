import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as TypeScript from 'typescript';
import { loadTypeScript, writeCodeCache } from './typescript-cache';

/**
 * The TypeScript compiler, loaded the first time a .ts file is, from the
 * image's code cache (typescript-cache.ts): the longest step of a cold start at
 * the smallest sizes. A .js handler never loads it.
 */
let compiler: typeof TypeScript | undefined;
const typescript = (): typeof TypeScript => (compiler ??= loadTypeScript().ts);

interface CompilableModule {
  _compile(code: string, filename: string): void;
}

/**
 * Lets require() load TypeScript files by transpiling them to CommonJS on the
 * fly (no type checking, like ts-node --transpile-only). Full transpilation,
 * unlike Node's built-in type stripping, so enums and namespaces work too.
 */
export function registerTypeScript(): void {
  const extensions = require.extensions as unknown as Record<string, (m: CompilableModule, f: string) => void>;
  extensions['.ts'] = (module, filename) => {
    module._compile(transpile(typescript(), fs.readFileSync(filename, 'utf8'), filename), filename);
  };
}

/**
 * The file as CommonJS, with an inline source map. Only syntax errors are reported (there is no type checking).
 * Without this check the transpiler "recovers" and runs different code than was written, e.g. `return {{{` as
 * `return {}`.
 */
export function transpile(ts: typeof TypeScript, source: string, filename: string): string {
  const { outputText, diagnostics } = ts.transpileModule(source, {
    fileName: filename,
    reportDiagnostics: true,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      inlineSourceMap: true,
      inlineSources: true,
    },
  });
  const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) throw new SyntaxError(describe(ts, errors));
  return outputText;
}

/** Writes the compiler's code cache, after a transpile of a handler like the ones FF deploys: run at the image's build. */
export function writeTypeScriptCache(cacheFile?: string): void {
  const handler = [
    'enum Greeting { Hello = "Hello" }',
    'interface Event { name?: string }',
    'export async function handler(event: Event): Promise<{ message: string }> {',
    '  return { message: `${Greeting.Hello} ${event?.name ?? "world"}` };',
    '}',
  ].join('\n');
  writeCodeCache((ts) => transpile(ts, handler, '/var/task/function.ts'), cacheFile);
}

/** "function.ts:3:11 Property assignment expected." for the first few errors. */
function describe(ts: typeof TypeScript, errors: readonly TypeScript.Diagnostic[]): string {
  return errors
    .slice(0, 3)
    .map((d) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
      if (!d.file || d.start === undefined) return message;
      const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
      return `${path.basename(d.file.fileName)}:${line + 1}:${character + 1} ${message}`;
    })
    .join('; ');
}
