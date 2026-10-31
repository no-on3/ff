import { BadRequestException } from '@nestjs/common';

/**
 * Inline TypeScript as JavaScript that AWS Lambda's Node.js runtime loads from `function.js`: transpiled as FF's
 * Node.js runtime transpiles it before running it (runtimes/nodejs/src/ts-hook.ts), to CommonJS, enums and namespaces
 * included, with no type checking, so that it runs on Lambda as it ran on FF; without the runtime's inline source map,
 * which Lambda doesn't need. TypeScript is loaded the first time this is asked for: most of the backend never needs it.
 * Code with a syntax error, which never loaded on FF either, is refused, its first errors named.
 */
export async function lambdaJavaScript(code: string): Promise<string> {
  const ts = await import('typescript');
  const { outputText, diagnostics } = ts.transpileModule(code, {
    fileName: 'function.ts',
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  const errors = (diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const named = errors.slice(0, 3).map((diagnostic) => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
      if (!diagnostic.file || diagnostic.start === undefined) return message;
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      return `function.ts:${line + 1}:${character + 1} ${message}`;
    });
    throw new BadRequestException(`The function's code doesn't transpile to JavaScript: ${named.join('; ')}`);
  }
  return outputText;
}
