/**
 * Worker thread that hosts user code. Loaded once per environment; receives
 * one invocation at a time from main.ts. If it hangs, runs out of memory, or
 * exits, main.ts terminates it and starts a fresh one. It runs in the task
 * root: main.ts changes directory before starting it, since worker threads can't.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
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

function loadHandler(): Handler {
  const separator = config.handler.lastIndexOf('.');
  if (separator <= 0) {
    throw new InitError('Runtime.MalformedHandlerName', `Bad handler "${config.handler}": expected <file>.<export>`);
  }
  const file = config.handler.slice(0, separator);
  const exportName = config.handler.slice(separator + 1);

  const base = path.resolve(config.taskRoot, file);
  const found = ['.ts', '.js', '.cjs'].map((ext) => base + ext).find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new InitError(
      'Runtime.ImportModuleError',
      `Cannot find module '${file}' in ${config.taskRoot} (tried .ts, .js, .cjs)`,
    );
  }

  registerTypeScript();
  let exported: Record<string, unknown>;
  try {
    exported = require(found);
  } catch (err) {
    const error = toError(err);
    const type = error instanceof SyntaxError ? 'Runtime.UserCodeSyntaxError' : 'Runtime.ImportModuleError';
    throw new InitError(type, `${error.name}: ${error.message}`);
  }

  const handler = exported[exportName];
  if (typeof handler !== 'function') {
    throw new InitError('Runtime.HandlerNotFound', `${file}.${exportName} is undefined or not exported`);
  }
  // As on AWS Lambda's Node.js 24 runtime, which refuses them with this error type.
  // AWS doesn't document whether an async handler with a third parameter is spared:
  // FF refuses any handler that declares one, at load, so the deploy fails with this message.
  if (handler.length >= 3) {
    throw new InitError(
      'Runtime.CallbackHandlerDeprecated',
      `${file}.${exportName} declares a third parameter, a callback. Callback-based handlers are not ` +
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
try {
  handler = loadHandler();
  send({ type: 'ready' });
} catch (err) {
  const error = err instanceof InitError ? err : new InitError('Runtime.ImportModuleError', toError(err).message);
  send({ type: 'init_error', errorType: error.errorType, errorMessage: error.message });
}

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
