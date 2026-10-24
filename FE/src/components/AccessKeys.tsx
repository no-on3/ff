import React, { useCallback, useEffect, useState } from 'react';
import { formatWhen } from '../lib/accounts';
import { exportLines, keyReach } from '../lib/buckets';
import { apiErrorMessage } from '../lib/functions';
import { Bucket, CreatedStorageKey, Queue, StorageKey, bucketsApi, queuesApi, storageKeysApi } from '../services/api';
import Copyable from './Copyable';
import { Panel } from './Panel';

/** A key's secret, this once, as the variables AWS's SDKs and CLI read: FF keeps it sealed, and never shows it again. */
const KeyOnce: React.FC<{ made: CreatedStorageKey; command: string; onDone(): void }> = ({ made, command, onDone }) => (
  <Panel
    title={`Access key ${made.id}`}
    description="Copy it now: its secret is shown only this once. FF keeps it sealed; revoke the key below to stop it."
    className="mb-6 border-green-300"
  >
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-gray-700">For your terminal, or a function's secrets: AWS's SDKs and CLI read these five</p>
        <Copyable value={exportLines(made)} label="the access key's variables" testId="key-variables" />
      </div>
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-gray-700">Then, as on AWS</p>
        <Copyable value={command} label="the command" />
      </div>
      <button type="button" className="btn btn-primary" onClick={onDone}>
        Done
      </button>
    </div>
  </Panel>
);

/** What a new key reaches, as the form's choice says it: '' for all the account's, else `bucket:<name>` or `queue:<name>`. */
const reachOf = (choice: string): { buckets?: string[]; queues?: string[] } =>
  choice.startsWith('bucket:') ? { buckets: [choice.slice(7)] } : choice.startsWith('queue:') ? { queues: [choice.slice(6)] } : {};

/**
 * The account's access keys, which AWS's SDKs and CLI use for its buckets and
 * its queues alike (ADR 0009, ADR 0010): its owners see, make and revoke them,
 * two at most. A key reaches every bucket and queue of the account, or one of
 * them alone. The page gives what it has listed; the rest is read here.
 */
const AccessKeys: React.FC<{ buckets?: Bucket[] | null; queues?: Queue[] | null; open: boolean }> = ({ buckets, queues, open }) => {
  const [keys, setKeys] = useState<StorageKey[] | null>(null);
  const [known, setKnown] = useState<{ buckets: Bucket[]; queues: Queue[] }>({ buckets: [], queues: [] });
  const [choice, setChoice] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [made, setMade] = useState<CreatedStorageKey | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys((await storageKeysApi.list()).data);
      setError(null);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  // What the form offers: the page's own lists, and the other kind read here.
  useEffect(() => {
    let current = true;
    void (async () => {
      const [ownBuckets, ownQueues] = await Promise.all([
        buckets === undefined ? bucketsApi.list().then((answer) => answer.data, () => []) : Promise.resolve(buckets ?? []),
        queues === undefined ? queuesApi.list().then((answer) => answer.data, () => []) : Promise.resolve(queues ?? []),
      ]);
      if (current) setKnown({ buckets: ownBuckets, queues: ownQueues });
    })();
    return () => {
      current = false;
    };
  }, [buckets, queues]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const makeKey = (event: React.FormEvent) => {
    event.preventDefault();
    void act(async () => setMade((await storageKeysApi.create({ ...reachOf(choice), readOnly })).data));
  };
  // The command shown with a key just made: one for what it reaches.
  const command = (key: CreatedStorageKey) =>
    key.queues ? `aws sqs list-queues` : `aws s3 ls s3://${key.buckets?.[0] ?? known.buckets[0]?.name ?? '<bucket>'}`;

  if (keys === null && !error) return null;
  return (
    <>
      {made && <KeyOnce made={made} command={command(made)} onDone={() => setMade(null)} />}
      <Panel title="Access keys" description="AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for AWS's SDKs and CLI, for the account's buckets and its queues alike. Two at most, so that one can replace the other.">
        {error && (
          <p role="alert" className="mb-3 text-red-700">
            {error}
          </p>
        )}
        {keys?.length === 0 ? (
          <p className="text-gray-600">No access key yet.</p>
        ) : (
          <ul className="mb-4 divide-y divide-gray-100" aria-label="The account's access keys">
            {(keys ?? []).map((key) => (
              <li key={key.id} className="flex flex-wrap items-center gap-3 py-2.5">
                <code className="font-mono text-[13px] text-ink">{key.id}</code>
                <span className="text-[13px] text-gray-600">{keyReach(key)}</span>
                <span className="text-[13px] text-gray-500">{key.lastUsedAt ? `last used ${formatWhen(key.lastUsedAt)}` : 'never used'}</span>
                <span className="ml-auto">
                  {revoking === key.id ? (
                    <span role="alertdialog" aria-label={`Revoke ${key.id}`} className="inline-flex items-center gap-2">
                      <span className="text-[13px] text-gray-700">Revoke it? Whatever uses it stops at once.</span>
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await storageKeysApi.revoke(key.id);
                            setRevoking(null);
                          })
                        }
                      >
                        Revoke
                      </button>
                      <button type="button" className="btn btn-secondary" onClick={() => setRevoking(null)}>
                        Keep it
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setRevoking(key.id)}
                      aria-label={`Revoke ${key.id}`}
                      className="rounded-md px-2 py-1 text-[13px] font-medium text-gray-500 hover:bg-red-50 hover:text-red-700"
                    >
                      Revoke
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {open && (keys?.length ?? 0) < 2 && (
          <form onSubmit={makeKey} className="flex flex-wrap items-center gap-3" aria-label="New access key">
            <select aria-label="What it reaches" className="select" value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Every bucket and queue</option>
              {known.buckets.map((bucket) => (
                <option key={`bucket:${bucket.name}`} value={`bucket:${bucket.name}`}>
                  Bucket {bucket.name} only
                </option>
              ))}
              {known.queues.map((queue) => (
                <option key={`queue:${queue.name}`} value={`queue:${queue.name}`}>
                  Queue {queue.name} only
                </option>
              ))}
            </select>
            <label className="inline-flex items-center gap-1.5 text-[13px] text-gray-700">
              <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
              Read-only
            </label>
            <button type="submit" className="btn btn-secondary" disabled={busy}>
              Make an access key
            </button>
          </form>
        )}
      </Panel>
    </>
  );
};

export default AccessKeys;
