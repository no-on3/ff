import { WinstonModuleOptions } from 'nest-winston';
import * as winston from 'winston';

/**
 * One console entry: "<time> [<level>] [<context>] <message>", then any stack
 * trace on the following lines. nest-winston passes Nest's traces (an
 * unhandled exception's, for example) as `stack`, a list.
 */
export function consoleLine({ timestamp, level, message, context, stack }: winston.Logform.TransformableInfo): string {
  const traces = (Array.isArray(stack) ? (stack as unknown[]) : [stack])
    .map((trace) => (trace instanceof Error ? (trace.stack ?? trace.message) : trace))
    .filter((trace): trace is string => typeof trace === 'string' && trace !== '');
  return [`${String(timestamp)} [${level}] [${String(context)}] ${String(message)}`, ...traces].join('\n');
}

export const winstonConfig: WinstonModuleOptions = {
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.ms(),
        winston.format.colorize(),
        winston.format.printf(consoleLine),
      ),
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
      ),
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json(),
      ),
    }),
  ],
};
