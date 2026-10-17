import { SetMetadata } from '@nestjs/common';
import { Role } from './principal';

export const ROLES = 'ff:roles';
export const ACTIVE_ACCOUNT = 'ff:active-account';

/** Only these roles may call the route; another gets 403 (D4). */
export const RequireRole = (...roles: Role[]) => SetMetadata(ROLES, roles);

/** Only an active account may call the route: a new account waits for approval during the beta (P-12). */
export const RequireActiveAccount = () => SetMetadata(ACTIVE_ACCOUNT, true);

/** Who may write: deploy, change, delete or invoke functions. Viewers only read (D4). */
export const WRITERS: Role[] = ['owner', 'developer'];
