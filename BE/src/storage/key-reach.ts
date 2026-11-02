import { ALL_FUNCTIONS, FUNCTION_ACCESS, FunctionAccess } from './storage-key.entity';

/** What an access key names of its account's: its buckets, its queues and its functions, null for none named. */
export interface KeyNames {
  buckets: string[] | null;
  queues: string[] | null;
  functions: string[] | null;
}

/** Whether a key names nothing, and so reaches all the account's buckets, queues and mail, as a key made before it could name any did. */
const namesNothing = (key: KeyNames): boolean => key.buckets === null && key.queues === null && key.functions === null;

/**
 * Whether a key reaches a bucket of its account: every one when it names
 * nothing; else those it names, none when it names queues or functions alone.
 */
export const reachesBucket = (key: KeyNames, name: string): boolean => (key.buckets === null ? namesNothing(key) : key.buckets.includes(name));

/** Whether a key reaches a queue of its account: every one when it names nothing; else those it names, none when it names others alone. */
export const reachesQueue = (key: KeyNames, name: string): boolean => (key.queues === null ? namesNothing(key) : key.queues.includes(name));

/** Whether a key reaches its account's mail, which it can't name: when it names nothing, as a key that names some reaches those alone. */
export const reachesMail = (key: KeyNames): boolean => namesNothing(key);

/** What a key says of its account's functions: whose key it is, the functions it names and its level with them. */
export interface FunctionReach {
  /** The function whose own key it is; null for one of the account's keys. */
  functionId: string | null;
  functions: string[] | null;
  functionAccess: FunctionAccess | null;
}

/**
 * What a key may do with a function of its account, by the function's name:
 * a function's own key invokes any, as a role allowed to invoke them does; an
 * account's key works at its level with those it names, or with all of them;
 * null when it doesn't reach the function, as a key that names none.
 */
export function functionAccessOf(key: FunctionReach, name: string): FunctionAccess | null {
  if (key.functionId !== null) return 'invoke';
  return key.functions?.includes(ALL_FUNCTIONS) || key.functions?.includes(name) ? key.functionAccess : null;
}

/** Whether a level invokes: invoke's, and write's, which does all a key may. */
export const mayInvoke = (access: FunctionAccess | null): boolean => access === 'invoke' || access === 'write';

/**
 * Whether a key may do what one of Lambda's operations needs with a function
 * of its account: an account's key at its level or above, each level doing
 * all the one before it does (read, then invoke, then write); a function's own
 * key invokes alone, as a role allowed to invoke and nothing more.
 */
export function mayUse(key: FunctionReach, name: string, needed: FunctionAccess): boolean {
  if (key.functionId !== null) return needed === 'invoke';
  const access = functionAccessOf(key, name);
  return access !== null && FUNCTION_ACCESS.indexOf(access) >= FUNCTION_ACCESS.indexOf(needed);
}

/** Whether a key may make one of Lambda's operations on the account, not on one function (ListFunctions, GetAccountSettings): an account's key that names functions. */
export const reachesAnyFunction = (key: FunctionReach): boolean => key.functionId === null && key.functions !== null;

/** A key as a refusal names it: its name and its ID, or its ID alone for a key without a name. */
export const keyLabel = (key: { id: string; name: string | null }): string => (key.name ? `${key.name} (${key.id})` : key.id);
