import { Logger } from '@nestjs/common';
import { AbstractLogger, LogLevel, LogMessage } from 'typeorm';

/**
 * TypeORM's lines through the backend's logger, so that in a JSON log each
 * one is a JSON object too, naming the request it was written for; TypeORM's
 * own logger writes to the console directly. What it logs is what the
 * `logging` setting says, as for TypeORM's own: the queries in development,
 * nothing in production.
 */
export class TypeOrmLogger extends AbstractLogger {
  private readonly logger = new Logger('TypeORM');

  protected writeLog(level: LogLevel, logMessage: LogMessage | string | number | (LogMessage | string | number)[]): void {
    for (const { type, prefix, message } of this.prepareLogMessages(logMessage, { highlightSql: false })) {
      const line = prefix ? `${prefix} ${message}` : String(message);
      switch (type ?? level) {
        case 'warn':
        case 'query-slow':
          this.logger.warn(line);
          break;
        case 'error':
        case 'query-error':
          this.logger.error(line);
          break;
        default:
          this.logger.log(line);
      }
    }
  }
}
