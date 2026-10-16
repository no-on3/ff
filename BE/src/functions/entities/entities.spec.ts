import { getMetadataArgsStorage } from 'typeorm';
import { FunctionMetrics } from '../../metrics/entities/function-metrics.entity';
import { FunctionInvocation } from './function-invocation.entity';

// Rows that reference a function must not block deleting it. Without
// ON DELETE CASCADE, DELETE /functions/:id fails with a foreign-key violation
// as soon as the function has been invoked (found by hack/e2e.sh).
describe('entity relations', () => {
  it.each([
    ['FunctionInvocation.function', FunctionInvocation],
    ['FunctionMetrics.function', FunctionMetrics],
  ])('%s cascades deletes', (_label, target) => {
    const relation = getMetadataArgsStorage().relations.find(
      (r) => r.target === target && r.propertyName === 'function',
    );

    expect(relation?.options.onDelete).toBe('CASCADE');
  });
});
