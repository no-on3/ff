/**
 * Worker thread that hosts user code. Loaded once per environment; receives
 * one invocation at a time from main.ts. If it hangs, runs out of memory, or
 * exits, main.ts terminates it and starts a fresh one.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { FunctionError, InvokeMessage, WorkerConfig, WorkerMessage } from './protocol';
import { registerTypeScript } from './ts-hook';

type Handler = (event: unknown, context: unknown) => unknown;

const config = workerData as WorkerConfig;
const port = parentPort!;
const send = (message: WorkerMessage) => port.postMessage(message);

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
  return handler as Handler;
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
  const context = {
    functionName: config.functionName,
    functionVersion: config.functionVersion,
    // A string, as in AWS Lambda's Node.js runtime.
    memoryLimitInMB: String(config.memoryLimitMb),
    awsRequestId: message.requestId,
    getRemainingTimeInMillis: () => Math.max(0, message.deadlineMs - Date.now()),
    callbackWaitsForEmptyEventLoop: true,
  };
  try {
    const value = await handler(message.event, context);
    send({ type: 'result', id: message.id, ok: true, body: JSON.stringify(value === undefined ? null : value) });
  } catch (err) {
    const error = toError(err);
    const failure: FunctionError = { errorType: error.name || 'Error', errorMessage: error.message };
    send({ type: 'result', id: message.id, ok: false, ...failure });
  }
});
