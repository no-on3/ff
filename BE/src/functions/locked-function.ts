import { EntityManager } from 'typeorm';
import { Function } from './entities/function.entity';
import { functionNotFound } from './function-not-found';

/**
 * The account's function, its row locked until the transaction ends, with its
 * package and its last version's number: publishes, deletions of versions and
 * changes of aliases of one function run one at a time, so that an alias never
 * names a version deleted meanwhile. Another account's is not found.
 */
export async function lockedFunction(manager: EntityManager, accountId: string, id: string): Promise<Function> {
  const function_ = await manager
    .createQueryBuilder(Function, 'f')
    .addSelect(['f.packageSha256', 'f.lastVersion'])
    .where('f.id = :id AND f.accountId = :accountId', { id, accountId })
    .setLock('pessimistic_write')
    .getOne();
  if (!function_) throw functionNotFound(id);
  return function_;
}
