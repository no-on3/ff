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
