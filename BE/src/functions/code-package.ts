import { createHash } from 'node:crypto';
import { PackageType, Runtime } from './entities/function.entity';

/**
 * A function's code as AWS Lambda describes it: how it comes (PackageType), what
 * its runtime calls (Handler), and its CodeSha256 and CodeSize.
 */

/** The handler of a function that names none: `handler` in the file `function`, where inline code is. */
export const DEFAULT_HANDLER = 'function.handler';
/** AWS Lambda's limit on a handler's length. */
export const MAX_HANDLER_LENGTH = 128;

/** The file inline code is, in its pods' /var/task: the `function` its handler names. */
export function codeFileName(runtime: Runtime): string {
  return runtime === Runtime.PYTHON ? 'function.py' : 'function.ts';
}

/** Inline code's CodeSha256 and CodeSize, as Lambda gives a package's: over its UTF-8 bytes, the hash in base64. */
export function inlineCodeFacts(code: string): { codeSha256: string; codeSize: number } {
  const bytes = Buffer.from(code, 'utf8');
  return { codeSha256: createHash('sha256').update(bytes).digest('base64'), codeSize: bytes.length };
}

/**
 * What is wrong with a handler as AWS Lambda writes one, whatever the runtime,
 * or nothing: `<file>.<export>` for Node.js, `<module>.<function>` for Python,
 * the file in a folder of the package if need be, `src/app.handler`. Lambda
 * only asks for 128 characters without whitespace, and its runtimes refuse the
 * rest when they load the code: here, the request is refused instead.
 */
export function handlerSyntaxProblem(handler: string): string | undefined {
  if (handler.length < 1 || handler.length > MAX_HANDLER_LENGTH) return `handler must be 1 to ${MAX_HANDLER_LENGTH} characters, as on AWS Lambda`;
  if (/\s/.test(handler)) return 'handler must not contain whitespace, as on AWS Lambda';
  const folders = handler.split('/');
  const name = folders.pop() as string;
  // Lambda's Node.js runtime refuses ".." anywhere; a path out of the package means nothing on FF.
  if (handler.includes('..') || handler.includes('\\') || folders.some((folder) => folder === '' || folder === '.')) {
    return 'handler must name a file inside the package, from its root: no leading /, no backslash, no . or .. folder';
  }
  if (!/^[^.]+\.[^.]/.test(name) || name.endsWith('.')) {
    return 'handler must be <file>.<function>, as on AWS Lambda: function.handler, or src/app.handler for a file in a folder';
  }
  return undefined;
}

/**
 * The handlers inline code may have: a function of the one file it is. Node.js
 * follows what comes after the file through the module's exports, as Lambda's
 * runtime does (function.handlers.main); Python takes the module's attribute
 * named after the last dot, which must be an identifier.
 */
const INLINE_HANDLER: Record<Runtime, RegExp> = {
  [Runtime.NODEJS]: /^function(\.[^./\\\s]+)+$/,
  [Runtime.PYTHON]: /^function\.[\p{XID_Start}_][\p{XID_Continue}]*$/u,
};

/** What is wrong with a handler for a function of this runtime and package, or nothing. */
export function handlerProblem(handler: string, runtime: Runtime, packageType: PackageType): string | undefined {
  const syntax = handlerSyntaxProblem(handler);
  if (syntax) return syntax;
  if (packageType === PackageType.INLINE && !INLINE_HANDLER[runtime].test(handler)) {
    return `handler must be function.<name> for inline code, which is the file ${codeFileName(runtime)}: function.handler, for example`;
  }
  return undefined;
}
