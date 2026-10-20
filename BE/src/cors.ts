import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { REASON_HEADER } from './admin/operator';
import { ACCOUNT_HEADER, DEV_ACCOUNT_HEADER } from './auth/principal';
import { REQUEST_ID_HEADER } from './common/request-context';

/** An export that holds only the newest of what matched (P-76): the admin dashboard says so. */
export const TRUNCATED_HEADER = 'x-ff-truncated';

/**
 * Which browser origins may call the API, and with what: the console sends a
 * token and the account it acts for (X-FF-Account; X-FF-Dev-Account in
 * development mode), and may read each answer's request ID (D4), the one to
 * quote when asking for help; the admin dashboard, whether an export was cut
 * short, and it sends a file's reason in X-FF-Reason (P-35).
 */
export function corsOptions(origins: string[]): CorsOptions {
  return {
    origin: origins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', ACCOUNT_HEADER, DEV_ACCOUNT_HEADER, REASON_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER, TRUNCATED_HEADER],
    credentials: true,
    maxAge: 3600,
  };
}
