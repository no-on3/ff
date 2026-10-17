import { Account } from '../accounts/entities/account.entity';
import { Invitation } from '../accounts/entities/invitation.entity';
import { Membership } from '../accounts/entities/membership.entity';
import { Plan } from '../accounts/entities/plan.entity';
import { User } from '../accounts/entities/user.entity';
import { ApiKey } from '../api-keys/entities/api-key.entity';
import { FunctionInvocation } from '../functions/entities/function-invocation.entity';
import { Function } from '../functions/entities/function.entity';
import { FunctionMetrics } from '../metrics/entities/function-metrics.entity';

/**
 * Every entity, listed explicitly rather than found by a file glob: a glob over
 * the build output also matches the compiled `.d.ts` files. Add new entities here.
 */
export const ENTITIES = [Plan, Account, User, Membership, Invitation, ApiKey, Function, FunctionInvocation, FunctionMetrics];
