import { SetMetadata } from '@nestjs/common';
import { Scope } from '../api-keys/api-key-format';
import { Role } from './principal';

export const ROLES = 'ff:roles';
export const ACTIVE_ACCOUNT = 'ff:active-account';
export const SCOPE = 'ff:scope';

/** Only these roles may call the route; another gets 403 (D4). */
export const RequireRole = (...roles: Role[]) => SetMetadata(ROLES, roles);

/** Only an active account may call the route: a new account waits for approval during the beta (P-12). */
export const RequireActiveAccount = () => SetMetadata(ACTIVE_ACCOUNT, true);

/**
 * The scope an API key needs to call the route (D3). A route without one can't
 * be called with a key at all: accounts, members and keys take a user's token.
 */
export const RequireScope = (scope: Scope) => SetMetadata(SCOPE, scope);

/** Who may write: deploy, change, delete or invoke functions. Viewers only read (D4). */
export const WRITERS: Role[] = ['owner', 'developer'];
