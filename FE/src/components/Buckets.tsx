import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatWhen } from '../lib/accounts';
import { bucketNameProblem, exportLines, keyReach, storageNotice } from '../lib/buckets';
import { formatSize } from '../lib/databases';
import { apiErrorMessage } from '../lib/functions';
import { can } from '../lib/session';
import { Bucket, CreatedStorageKey, StorageKey, bucketsApi, storageKeysApi } from '../services/api';
import { useSession } from '../session/session';
import Copyable from './Copyable';
import Icon from './Icon';
import { Page, PageHeader } from './Page';
import { Callout, Panel } from './Panel';
import StatusPill from './StatusPill';

/** A key's secret, this once, as the variables AWS's SDKs and CLI read: FF keeps it sealed, and never shows it again. */
const KeyOnce: React.FC<{ made: CreatedStorageKey; bucket: string | undefined; onDone(): void }> = ({ made, bucket, onDone }) => (
  <Panel
    title={`Access key ${made.id}`}
    description="Copy it now: its secret is shown only this once. FF keeps it sealed; revoke the key below to stop it."
    className="mb-6 border-green-300"
  >
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-gray-700">For your terminal, or a function's secrets: AWS's SDKs and CLI read these four</p>
        <Copyable value={exportLines(made)} label="the access key's variables" testId="key-variables" />
      </div>
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-gray-700">Then, as with S3</p>
        <Copyable value={`aws s3 ls s3://${bucket ?? '<bucket>'}`} label="the command" />
      </div>
      <button type="button" className="btn btn-primary" onClick={onDone}>
        Done
      </button>
    </div>
  </Panel>
);

/**
 * The account's buckets, as AWS S3 gives them (ADR 0009): every member sees
 * them; owners and developers of an active account make and delete them; the
 * owners make the access keys AWS's SDKs and CLI use, and revoke them.
 */
const Buckets: React.FC = () => {
  const { account } = useSession();
  const [buckets, setBuckets] = useState<Bucket[] | null>(null);
  const [keys, setKeys] = useState<StorageKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<{ bucket: Bucket; force: boolean } | null>(null);
  const [keyBucket, setKeyBucket] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [made, setMade] = useState<CreatedStorageKey | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const owner = account ? can(account.role, 'manage the account') : false;

  const load = useCallback(async () => {
    try {
      setBuckets((await bucketsApi.list()).data);
      if (owner) setKeys((await storageKeysApi.list()).data);
      setError(null);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  }, [owner]);
  useEffect(() => {
    void load();
  }, [load, account?.id]);

  if (!account) return null;
  const writer = can(account.role, 'change buckets');
  const open = account.status === 'active' && !account.storageDisabledAt;
  const problem = naming ? bucketNameProblem(name) : null;
  const notice = storageNotice(account);
  // Run an action, then read the page again; its failure in the API's words.
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
  const create = (event: React.FormEvent) => {
    event.preventDefault();
    if (problem) return;
    void act(async () => {
      await bucketsApi.create(name);
      setNaming(false);
      setName('');
    });
  };
  const makeKey = (event: React.FormEvent) => {
    event.preventDefault();
    void act(async () => setMade((await storageKeysApi.create({ ...(keyBucket ? { buckets: [keyBucket] } : {}), readOnly })).data));
  };

  return (
    <Page>
      <PageHeader
        title="Buckets"
        description="Files, as AWS S3 keeps them: AWS's SDKs and CLI reach them at FF's S3 endpoint with one of the account's access keys, only the endpoint changed. FF keeps no copy of them at a second site."
        actions={
          writer &&
          open &&
          !naming && (
            <button type="button" className="btn btn-primary" onClick={() => setNaming(true)}>
              <Icon name="plus" />
              Create bucket
            </button>
          )
        }
      />
      {notice && !account.storageDisabledAt && (
        <Callout tone={notice.tone} role="status" title={notice.title} className="mb-6">
          {notice.text}
        </Callout>
      )}
      {account.storageDisabledAt && (
        <Callout tone="danger" role="alert" title="FF turned this account's buckets off" className="mb-6">
          {account.storageDisabledReason} Its keys are refused, and no bucket can be made, until FF turns them on again. The files are kept.
        </Callout>
      )}
      {naming && (
        <form onSubmit={create} className="card mb-6 space-y-3" aria-label="New bucket">
          <label htmlFor="bucket-name" className="block text-sm font-medium text-gray-700">
            Name
          </label>
          <input id="bucket-name" className="input max-w-sm font-mono" maxLength={63} value={name} onChange={(e) => setName(e.target.value.trim())} autoFocus />
          <p className={`text-xs ${problem && name !== '' ? 'text-amber-900' : 'text-gray-500'}`}>
            {problem && name !== '' ? problem : 'Lower-case letters, digits and hyphens, unique across FF, as on AWS: it is part of the bucket\'s address.'}
          </p>
          <div className="flex gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy || !!problem}>
              {busy ? 'Creating…' : 'Create'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setNaming(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {made && <KeyOnce made={made} bucket={made.buckets?.[0] ?? buckets?.[0]?.name} onDone={() => setMade(null)} />}
      {error && (
        <p role="alert" className="mb-4 text-red-700">
          {error}
        </p>
      )}
      <section className="mb-8 overflow-hidden rounded-lg border border-line bg-white shadow-sm" aria-label="The account's buckets">
        {buckets === null && !error ? (
          <p className="px-4 py-10 text-center text-gray-500">Loading…</p>
        ) : buckets?.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <div className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-blue-50 text-blue-600">
              <Icon name="buckets" size={20} />
            </div>
            <h2 className="text-base font-semibold text-ink">No buckets yet</h2>
            <p className="mx-auto mt-1 max-w-md text-gray-600">
              {writer && open ? 'Create one here, or from your terminal with ' : 'Owners and developers make them here, or from a terminal with '}
              <code className="font-mono text-[13px]">ff buckets create</code>.
            </p>
          </div>
        ) : (
          buckets && (
            <div className="relative overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-gray-50/70 text-xs text-gray-500">
                  <tr className="border-b border-line">
                    <th scope="col" className="px-3.5 py-2.5 font-medium">Name</th>
                    <th scope="col" className="px-3.5 py-2.5 text-right font-medium">Size</th>
                    <th scope="col" className="hidden px-3.5 py-2.5 font-medium md:table-cell">Address</th>
                    <th scope="col" className="hidden px-3.5 py-2.5 font-medium md:table-cell">Created</th>
                    {writer && (
                      <th scope="col" className="px-3.5 py-2.5">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {buckets.map((bucket) => (
                    <tr key={bucket.name} className="hover:bg-gray-50/70">
                      <td className="px-3.5 py-3">
                        <Link to={`/buckets/${bucket.name}`} className="font-semibold text-ink hover:underline">
                          {bucket.name}
                        </Link>
                        {bucket.status === 'deleting' && (
                          <span className="ml-2">
                            <StatusPill tone="busy" label="Deleting" title="Being emptied and deleted: no S3 request reaches it" />
                          </span>
                        )}
                      </td>
                      <td className="px-3.5 py-3 text-right whitespace-nowrap tabular-nums text-gray-700" title={bucket.measuredAt ? `As measured ${formatWhen(bucket.measuredAt)}` : 'Measured within the hour'}>
                        {formatSize(bucket.sizeBytes)}
                      </td>
                      <td className="hidden px-3.5 py-3 font-mono text-xs text-gray-600 md:table-cell">{bucket.url}</td>
                      <td className="hidden px-3.5 py-3 whitespace-nowrap text-gray-600 md:table-cell">{formatWhen(bucket.createdAt)}</td>
                      {writer && (
                        <td className="px-3.5 py-3 text-right whitespace-nowrap">
                          {deleting?.bucket.name === bucket.name ? (
                            <span role="alertdialog" aria-label={`Delete ${bucket.name}`} className="inline-flex flex-wrap items-center justify-end gap-2">
                              <label className="inline-flex items-center gap-1.5 text-[13px] text-gray-700">
                                <input type="checkbox" checked={deleting.force} onChange={(e) => setDeleting({ bucket, force: e.target.checked })} />
                                Its files too
                              </label>
                              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(async () => {
                                await bucketsApi.remove(bucket.name, deleting.force);
                                setDeleting(null);
                              })}>
                                Delete
                              </button>
                              <button type="button" className="btn btn-secondary" onClick={() => setDeleting(null)}>
                                Keep it
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setDeleting({ bucket, force: false })}
                              aria-label={`Delete ${bucket.name}`}
                              className="rounded-md px-2 py-1 text-[13px] font-medium text-gray-500 hover:bg-red-50 hover:text-red-700"
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </section>
      {owner && keys && (
        <Panel title="Access keys" description="AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for AWS's SDKs and CLI. Two at most, so that one can replace the other.">
          {keys.length === 0 ? (
            <p className="text-gray-600">No access key yet.</p>
          ) : (
            <ul className="mb-4 divide-y divide-gray-100" aria-label="The account's access keys">
              {keys.map((key) => (
                <li key={key.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <code className="font-mono text-[13px] text-ink">{key.id}</code>
                  <span className="text-[13px] text-gray-600">{keyReach(key)}</span>
                  <span className="text-[13px] text-gray-500">{key.lastUsedAt ? `last used ${formatWhen(key.lastUsedAt)}` : 'never used'}</span>
                  <span className="ml-auto">
                    {revoking === key.id ? (
                      <span role="alertdialog" aria-label={`Revoke ${key.id}`} className="inline-flex items-center gap-2">
                        <span className="text-[13px] text-gray-700">Revoke it? Whatever uses it stops at once.</span>
                        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(async () => {
                          await storageKeysApi.revoke(key.id);
                          setRevoking(null);
                        })}>
                          Revoke
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={() => setRevoking(null)}>
                          Keep it
                        </button>
                      </span>
                    ) : (
                      <button type="button" onClick={() => setRevoking(key.id)} aria-label={`Revoke ${key.id}`} className="rounded-md px-2 py-1 text-[13px] font-medium text-gray-500 hover:bg-red-50 hover:text-red-700">
                        Revoke
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {open && keys.length < 2 && (
            <form onSubmit={makeKey} className="flex flex-wrap items-center gap-3" aria-label="New access key">
              <select aria-label="Buckets it reaches" className="select" value={keyBucket} onChange={(e) => setKeyBucket(e.target.value)}>
                <option value="">Every bucket</option>
                {(buckets ?? []).map((bucket) => (
                  <option key={bucket.name} value={bucket.name}>
                    {bucket.name} only
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
      )}
    </Page>
  );
};

export default Buckets;
