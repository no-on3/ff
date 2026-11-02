import { KeyNames, reachesBucket, reachesMail, reachesQueue } from './key-reach';

const naming = (names: Partial<KeyNames>): KeyNames => ({ buckets: null, queues: null, functions: null, ...names });

describe("what an access key reaches of its account's buckets, queues and mail", () => {
  it('reaches every bucket and queue, and the mail, when it names nothing, as keys made before they could name any do', () => {
    const key = naming({});
    expect([reachesBucket(key, 'photos'), reachesQueue(key, 'orders'), reachesMail(key)]).toEqual([true, true, true]);
  });

  it('reaches the buckets it names alone, and no queue nor the mail, when it names buckets alone', () => {
    const key = naming({ buckets: ['photos'] });
    expect([reachesBucket(key, 'photos'), reachesBucket(key, 'exports'), reachesQueue(key, 'orders'), reachesMail(key)]).toEqual([true, false, false, false]);
  });

  it('reaches the queues it names alone, and no bucket nor the mail, when it names queues alone', () => {
    const key = naming({ queues: ['orders'] });
    expect([reachesQueue(key, 'orders'), reachesQueue(key, 'invoices'), reachesBucket(key, 'photos'), reachesMail(key)]).toEqual([true, false, false, false]);
  });

  it('reaches what it names of each when it names both', () => {
    const key = naming({ buckets: ['photos'], queues: ['orders'] });
    expect([reachesBucket(key, 'photos'), reachesQueue(key, 'orders'), reachesBucket(key, 'exports'), reachesQueue(key, 'invoices')]).toEqual([true, true, false, false]);
  });

  it('reaches no bucket, no queue and not the mail when it names functions alone, all of them as much as some', () => {
    for (const functions of [['thumbnails'], ['*']]) {
      const key = naming({ functions });
      expect([reachesBucket(key, 'photos'), reachesQueue(key, 'orders'), reachesMail(key)]).toEqual([false, false, false]);
    }
    expect(reachesBucket(naming({ buckets: ['photos'], functions: ['thumbnails'] }), 'photos')).toBe(true);
  });
});
