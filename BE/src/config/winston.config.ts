import { WinstonModuleOptions } from 'nest-winston';
import * as winston from 'winston';
import { currentRequestId } from '../common/request-context';
import { LogFormat } from './configuration';

// The format is the configuration's: read here too, by main.ts, before the configuration is loaded.
export { LogFormat, logFormat } from './configuration';

/** The stack traces of an entry: nest-winston passes Nest's (an unhandled exception's, for example) as `stack`, a list. */
function tracesOf(stack: unknown): string[] {
  return (Array.isArray(stack) ? (stack as unknown[]) : [stack])
    .map((trace) => (trace instanceof Error ? (trace.stack ?? trace.message) : trace))
    .filter((trace): trace is string => typeof trace === 'string' && trace !== '');
}

/** One console entry: "<time> [<level>] [<context>] <message>", then any stack trace on the following lines. */
export function consoleLine({ timestamp, level, message, context, stack }: winston.Logform.TransformableInfo): string {
  return [`${String(timestamp)} [${level}] [${String(context)}] ${String(message)}`, ...tracesOf(stack)].join('\n');
}

/** One JSON object a line: its time, level, context and message, the request it was logged in, and an error's stack. */
export function jsonLine({ timestamp, level, message, context, stack, requestId }: winston.Logform.TransformableInfo): string {
  const traces = tracesOf(stack);
  return JSON.stringify({
    time: timestamp,
    level,
    context,
    message,
    ...(typeof requestId === 'string' ? { requestId } : {}),
    ...(traces.length ? { stack: traces } : {}),
  });
}

/** Adds the ID of the request being served, when there is one, to each entry as it is logged. */
export const withRequestId = winston.format((info) => {
  const requestId = currentRequestId();
  if (requestId) info.requestId = requestId;
  return info;
});

/** The backend's logger: stdout only, which the cluster keeps; JSON or readable lines. */
export function winstonConfig(format: LogFormat): WinstonModuleOptions {
  return {
    format: withRequestId(),
    transports: [
      new winston.transports.Console({
        format:
          format === 'json'
            ? winston.format.combine(winston.format.timestamp(), winston.format.printf(jsonLine))
            : winston.format.combine(winston.format.timestamp(), winston.format.colorize(), winston.format.printf(consoleLine)),
      }),
    ],
  };
}
