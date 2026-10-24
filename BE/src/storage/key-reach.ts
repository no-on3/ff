/** What an access key names of its account's: its buckets and its queues, null for none named. */
export interface KeyNames {
  buckets: string[] | null;
  queues: string[] | null;
}

/**
 * Whether a key reaches a bucket of its account: every one when it names
 * neither buckets nor queues, as a key of its own made before it could name
 * queues does; else those it names, none when it names queues alone.
 */
export const reachesBucket = (key: KeyNames, name: string): boolean => (key.buckets === null ? key.queues === null : key.buckets.includes(name));

/** Whether a key reaches a queue of its account: every one when it names neither; else those it names, none when it names buckets alone. */
export const reachesQueue = (key: KeyNames, name: string): boolean => (key.queues === null ? key.buckets === null : key.queues.includes(name));
