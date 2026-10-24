import { reachesBucket, reachesQueue } from './key-reach';

describe("what an access key reaches of its account's buckets and queues", () => {
  it('reaches every bucket and queue when it names neither, as keys made before queues do', () => {
    const key = { buckets: null, queues: null };
    expect([reachesBucket(key, 'photos'), reachesQueue(key, 'orders')]).toEqual([true, true]);
  });

  it('reaches the buckets it names alone, and no queue, when it names buckets alone', () => {
    const key = { buckets: ['photos'], queues: null };
    expect([reachesBucket(key, 'photos'), reachesBucket(key, 'exports'), reachesQueue(key, 'orders')]).toEqual([true, false, false]);
  });

  it('reaches the queues it names alone, and no bucket, when it names queues alone', () => {
    const key = { buckets: null, queues: ['orders'] };
    expect([reachesQueue(key, 'orders'), reachesQueue(key, 'invoices'), reachesBucket(key, 'photos')]).toEqual([true, false, false]);
  });

  it('reaches what it names of each when it names both', () => {
    const key = { buckets: ['photos'], queues: ['orders'] };
    expect([reachesBucket(key, 'photos'), reachesQueue(key, 'orders'), reachesBucket(key, 'exports'), reachesQueue(key, 'invoices')]).toEqual([true, true, false, false]);
  });
});
