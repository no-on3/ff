import { FunctionInvocation } from '../functions/entities/function-invocation.entity';
import { Function } from '../functions/entities/function.entity';
import { FunctionMetrics } from '../metrics/entities/function-metrics.entity';

/**
 * Every entity, listed explicitly rather than found by a file glob: a glob over
 * the build output also matches the compiled `.d.ts` files. Add new entities here.
 */
export const ENTITIES = [Function, FunctionInvocation, FunctionMetrics];
