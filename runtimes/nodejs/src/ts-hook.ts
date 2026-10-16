import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

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
    const source = fs.readFileSync(filename, 'utf8');
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
    // Only syntax errors are reported (there is no type checking). Without this check the
    // transpiler "recovers" and runs different code than was written, e.g. `return {{{` as `return {}`.
    const errors = (diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) throw new SyntaxError(describe(errors));
    module._compile(outputText, filename);
  };
}

/** "function.ts:3:11 Property assignment expected." for the first few errors. */
function describe(errors: readonly ts.Diagnostic[]): string {
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
