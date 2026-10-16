import * as fs from 'node:fs';
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
    const { outputText } = ts.transpileModule(source, {
      fileName: filename,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        inlineSourceMap: true,
        inlineSources: true,
      },
    });
    module._compile(outputText, filename);
  };
}
