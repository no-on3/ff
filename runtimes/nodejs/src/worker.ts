/**
 * Worker thread that hosts user code. Loaded once per environment; receives
 * one invocation at a time from main.ts. If it hangs, runs out of memory, or
 * exits, main.ts terminates it and starts a fresh one. It runs in the task
 * root: main.ts changes directory before starting it, since worker threads can't.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import { END_OF_CALL } from './protocol';
import type { FunctionError, InvokeMessage, WorkerConfig, WorkerMessage } from './protocol';
import { registerTypeScript } from './ts-hook';

type Handler = (event: unknown, context: unknown) => unknown;

const config = workerData as WorkerConfig;
const port = parentPort!;
const send = (message: WorkerMessage) => port.postMessage(message);
// The end-of-call markers go through the streams' own write, taken before user code loads: code that
// replaces process.stdout.write, to add a prefix for example, would otherwise change or keep them.
const writeStdout = process.stdout.write.bind(process.stdout);
const writeStderr = process.stderr.write.bind(process.stderr);

class InitError extends Error {
  constructor(
    readonly errorType: string,
    message: string,
  ) {
    super(message);
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

// Stack traces point at the lines of the user's TypeScript, not at its transpiled output.
process.setSourceMapsEnabled(true);

/**
 * Node's own import(), which tsc turns into require() in CommonJS output: an ES module needs it, its
 * top-level await for one.
 */
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>;

/**
 * Whether Node takes the .js files of this folder for ES modules: the nearest package.json says
 * "type": "module", as AWS Lambda's runtime reads it, going no higher than a node_modules folder.
 */
function inModuleScope(folder: string): boolean {
  for (let dir = folder; !dir.endsWith(`${path.sep}node_modules`); dir = path.dirname(dir)) {
    const manifest = path.join(dir, 'package.json');
    if (fs.existsSync(manifest)) {
      try {
        return JSON.parse(fs.readFileSync(manifest, 'utf8'))?.type === 'module';
      } catch {
        return false;
      }
    }
    if (dir === path.dirname(dir)) return false;
  }
  return false;
}

/**
 * The module's exports, from its first file that exists, in the order of AWS Lambda's Node.js runtime: the
 * name itself, then .js, an ES module where its package says so, then .mjs, then .cjs. FF takes .ts last,
 * transpiled. ES modules are imported, the rest required.
 */
async function loadModule(base: string, shown: string): Promise<Record<string, unknown>> {
  const candidates: Array<[string, 'require' | 'import']> = [
    [base, 'require'],
    [`${base}.js`, inModuleScope(path.dirname(base)) ? 'import' : 'require'],
    [`${base}.mjs`, 'import'],
    [`${base}.cjs`, 'require'],
    [`${base}.ts`, 'require'],
  ];
  const found = candidates.find(([file]) => fs.existsSync(file));
  if (!found) {
    throw new InitError('Runtime.ImportModuleError', `Cannot find module '${shown}' in ${config.taskRoot}: no ${shown}.js, .mjs, .cjs or .ts there`);
  }
  const [file, how] = found;
  registerTypeScript();
  try {
    return how === 'import' ? await importModule(pathToFileURL(file).href) : require(file);
  } catch (err) {
    const error = toError(err);
    const type = error instanceof SyntaxError ? 'Runtime.UserCodeSyntaxError' : 'Runtime.ImportModuleError';
    throw new InitError(type, `${error.name}: ${error.message}`);
  }
}

/**
 * The handler, as AWS Lambda's Node.js runtime finds it: `[<folders>/]<module>.<export>`, the module's
 * name up to the first dot after the last slash, and what follows a path through its exports, so that
 * `src/api.handlers.get` is `handlers.get` of src/api.js.
 */
async function loadHandler(): Promise<Handler> {
  const name = config.handler;
  if (name.includes('..')) {
    throw new InitError('Runtime.MalformedHandlerName', `Bad handler "${name}": '..' is not allowed, the file is in the package`);
  }
  const moduleAndExport = path.basename(name);
  const folders = name.slice(0, name.length - moduleAndExport.length);
  const [, moduleName, exportPath] = /^([^.]+)\.(.+)$/.exec(moduleAndExport) ?? [];
  if (!moduleName || !exportPath) {
    throw new InitError('Runtime.MalformedHandlerName', `Bad handler "${name}": expected <file>.<export>`);
  }

  const exported = await loadModule(path.resolve(config.taskRoot, folders, moduleName), `${folders}${moduleName}`);
  const handler = exportPath.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | null | undefined)?.[key], exported);
  if (handler === undefined) throw new InitError('Runtime.HandlerNotFound', `${name} is undefined or not exported`);
  if (typeof handler !== 'function') throw new InitError('Runtime.HandlerNotFound', `${name} is not a function`);
  // As on AWS Lambda's Node.js 24 runtime, which refuses them with this error type.
  // AWS doesn't document whether an async handler with a third parameter is spared:
  // FF refuses any handler that declares one, at load, so the deploy fails with this message.
  if (handler.length >= 3) {
    throw new InitError(
      'Runtime.CallbackHandlerDeprecated',
      `${name} declares a third parameter, a callback. Callback-based handlers are not ` +
        'supported from Node.js 24 on, as on AWS Lambda: use an async handler that returns its ' +
        'result or throws, async (event, context) => result.',
    );
  }
  return handler as Handler;
}

/** The frames of an error's stack that are user code: neither the runtime's own nor Node's internals. */
function userFrames(error: Error): string[] {
  return (error.stack ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at ') && !line.includes(__dirname) && !line.includes('node:internal'));
}

/** The JSON text of a handler's result. Throws for what JSON can't hold: a function, a symbol, a BigInt, a cycle. */
function marshal(value: unknown): string {
  const body = JSON.stringify(value === undefined ? null : value);
  if (typeof body !== 'string') throw new TypeError(`a ${typeof value} has no JSON representation`);
  return body;
}

let handler: Handler | undefined;
loadHandler().then(
  (loaded) => {
    handler = loaded;
    send({ type: 'ready' });
  },
  (err: unknown) => {
    const error = err instanceof InitError ? err : new InitError('Runtime.ImportModuleError', toError(err).message);
    send({ type: 'init_error', errorType: error.errorType, errorMessage: error.message });
  },
);

port.on('message', async (message: InvokeMessage) => {
  if (message.type !== 'invoke' || !handler) return;
  const result = await run(handler, message);
  // The call's output ends here, on both streams, ahead of its result: main.ts prints END after both markers.
  writeStdout(`${END_OF_CALL}${message.id}\n`);
  writeStderr(`${END_OF_CALL}${message.id}\n`);
  send(result);
});

/** Runs the handler once: the result message, the handler's value as JSON, or its error. */
async function run(handler: Handler, message: InvokeMessage): Promise<WorkerMessage> {
  const context = {
    functionName: config.functionName,
    functionVersion: config.functionVersion,
    // A string, as in AWS Lambda's Node.js runtime.
    memoryLimitInMB: String(config.memoryLimitMb),
    awsRequestId: message.requestId,
    getRemainingTimeInMillis: () => Math.max(0, message.deadlineMs - Date.now()),
    // No callbackWaitsForEmptyEventLoop: it went with callback handlers, as on Lambda's Node.js 24.
  };
  let value: unknown;
  try {
    value = await handler(message.event, context);
  } catch (err) {
    const error = toError(err);
    const failure: FunctionError = { errorType: error.name || 'Error', errorMessage: error.message };
    return { type: 'result', id: message.id, ok: false, ...failure, stackTrace: userFrames(error) };
  }
  try {
    return { type: 'result', id: message.id, ok: true, body: marshal(value) };
  } catch (err) {
    const errorMessage = `Unable to marshal response: ${toError(err).message}`;
    return { type: 'result', id: message.id, ok: false, errorType: 'Runtime.MarshalError', errorMessage };
  }
}
