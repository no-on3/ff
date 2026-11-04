import { QueryFailedError } from 'typeorm';

/** PostgreSQL's unique_violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * Whether a query was refused by a unique index: a name the account has
 * already, or a row another request saved first.
 */
export function isUniqueViolation(error: unknown): error is QueryFailedError {
  return error instanceof QueryFailedError && (error.driverError as { code?: string } | undefined)?.code === UNIQUE_VIOLATION;
}
