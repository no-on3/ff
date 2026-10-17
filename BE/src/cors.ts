import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { ACCOUNT_HEADER, DEV_ACCOUNT_HEADER } from './auth/principal';
import { REQUEST_ID_HEADER } from './common/request-context';

/**
 * Which browser origins may call the API, and with what: the console sends a
 * token and the account it acts for (X-FF-Account; X-FF-Dev-Account in
 * development mode), and may read each answer's request ID (D4), the one to
 * quote when asking for help.
 */
export function corsOptions(origins: string[]): CorsOptions {
  return {
    origin: origins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', ACCOUNT_HEADER, DEV_ACCOUNT_HEADER],
    exposedHeaders: [REQUEST_ID_HEADER],
    credentials: true,
    maxAge: 3600,
  };
}
