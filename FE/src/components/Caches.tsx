import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatWhen } from '../lib/accounts';
import { DEFAULT_SECRET, STATUS_INFO, cacheNameProblem, cliCommand, memoryShare, readsSummary } from '../lib/caches';
import { formatSize } from '../lib/databases';
import { secretProblem } from '../lib/environment';
import { apiErrorMessage } from '../lib/functions';
import { can } from '../lib/session';
import { Cache, CacheMetrics, CacheWithPassword, Function, cachesApi, functionsApi, secretsApi } from '../services/api';
import { useSession } from '../session/session';
import Copyable from './Copyable';
import Icon from './Icon';
import { Page, PageHeader } from './Page';
import { Panel } from './Panel';
import StatusPill from './StatusPill';

/**
 * A cache's address with its password, this once: FF keeps no copy. It can
 * go straight into a function's secret, which the function reads as
 * process.env.REDIS_URL, as redis, ioredis and redis-py take it.
 */
const AddressOnce: React.FC<{ made: CacheWithPassword; onDone(): void }> = ({ made, onDone }) => {
  const [functions, setFunctions] = useState<Function[]>([]);
  const [functionId, setFunctionId] = useState('');
  const [secret, setSecret] = useState(DEFAULT_SECRET);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [set, setSet] = useState<string[]>([]);

  useEffect(() => {
    functionsApi
      .getAllFunctions()
      .then(({ data }) => setFunctions(data))
      .catch(() => setFunctions([]));
  }, []);

  const asSecret = async (event: React.FormEvent) => {
    event.preventDefault();
    const name = secret.trim();
    const problem = functionId ? secretProblem(name, made.url, []) : 'Choose a function';
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await secretsApi.change(functionId, { [name]: made.url });
      const fn = functions.find((candidate) => candidate.id === functionId);
      setSet((done) => [...done, `${name} is set on ${fn?.name ?? 'the function'}: its new version is live.`]);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={`Connect to "${made.name}"`} description="Copy it now: the password is shown only this once. FF keeps no copy; a new one can be made later." className="mb-6 border-green-300">
      <div className="space-y-4">
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-gray-700">Its address, with its password</p>
          <Copyable value={made.url} label="the address" testId="cache-url" />
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-gray-700">From your terminal</p>
          <Copyable value={cliCommand(made.url)} label="the redis-cli command" />
        </div>
        <form onSubmit={asSecret} className="space-y-2" aria-label="Set it as a function's secret">
          <p className="text-[13px] font-medium text-gray-700">Or give it to a function, as a secret it reads from its environment</p>
          <div className="flex flex-wrap items-center gap-2">
            <select aria-label="Function" className="select" value={functionId} onChange={(e) => setFunctionId(e.target.value)}>
              <option value="">Choose a function</option>
              {functions.map((fn) => (
                <option key={fn.id} value={fn.id}>
                  {fn.name}
                </option>
              ))}
            </select>
            <input aria-label="Secret name" className="input w-48 font-mono" value={secret} onChange={(e) => setSecret(e.target.value)} />
            <button type="submit" className="btn btn-secondary" disabled={busy}>
              {busy ? 'Setting…' : 'Set as its secret'}
            </button>
          </div>
          {set.map((line) => (
            <p key={line} role="status" className="text-[13px] text-green-800">
              {line}
            </p>
          ))}
          {error && (
            <p role="alert" className="text-[13px] text-red-700">
              {error}
            </p>
          )}
        </form>
        <button type="button" className="btn btn-primary" onClick={onDone}>
          Done
        </button>
      </div>
    </Panel>
  );
};

/** Its memory: what its keys use now, and the share of the plan's, past which the least recently used keys go. */
const MemoryUse: React.FC<{ cache: Cache }> = ({ cache }) => {
  const share = memoryShare(cache);
  return (
    <span title={`${formatSize(cache.bytesUsedForCache)} of the plan's ${cache.memoryMb} MB: past it, the least recently used keys go`}>
      {formatSize(cache.bytesUsedForCache)}
      <span className="text-gray-500"> of {cache.memoryMb} MB</span>
      {share !== null && <span className={`ml-1.5 text-xs ${share >= 80 ? 'text-amber-800' : 'text-gray-500'}`}>{share}%</span>}
    </span>
  );
};

/** Its reads over the last day, from its hourly metrics, as CloudWatch names ElastiCache's; alarms on them are made on the Alarms page. */
const LastDay: React.FC<{ name: string }> = ({ name }) => {
  const [metrics, setMetrics] = useState<CacheMetrics | null>(null);
  useEffect(() => {
    let current = true;
    const start = new Date(Date.now() - 23 * 3_600_000).toISOString();
    cachesApi
      .metrics(name, { start })
      .then(({ data }) => current && setMetrics(data))
      .catch(() => current && setMetrics(null));
    return () => {
      current = false;
    };
  }, [name]);
  if (!metrics) return null;
  const { reads, hitPercent, evictions } = readsSummary(metrics);
  return (
    <div className="text-xs text-gray-500" aria-label={`The reads of ${name}`}>
      {reads === 0
        ? 'No read in the last 24 hours.'
        : `${reads.toLocaleString('en-US')} read${reads === 1 ? '' : 's'} in the last 24 hours, ${hitPercent}% found their key${evictions > 0 ? `, ${evictions.toLocaleString('en-US')} key${evictions === 1 ? '' : 's'} let go` : ''}.`}
    </div>
  );
};

/** What a writer may ask of one cache: a new password, or its deletion, each asked first. */
type Asking = { cache: Cache; what: 'password' | 'delete' };

/**
 * The account's caches, Valkey as AWS ElastiCache gives it (ADR 0013):
 * every member sees them, their memory and connections now; owners and
 * developers of an active account make them, their address shown once, give
 * them a new password, and delete them, with their keys.
 */
const Caches: React.FC = () => {
  const { account } = useSession();
  const [caches, setCaches] = useState<Cache[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<CacheWithPassword | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);

  const load = useCallback(async () => {
    try {
      setCaches((await cachesApi.list()).data);
      setError(null);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, account?.id]);

  if (!account) return null;
  const writer = can(account.role, 'change caches');
  const active = account.status === 'active';
  const mayCreate = writer && active;
  const problem = naming ? cacheNameProblem(name) : null;

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (problem) return;
    setCreating(true);
    setError(null);
    try {
      setMade((await cachesApi.create(name)).data);
      setNaming(false);
      setName('');
      await load();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setCreating(false);
    }
  };
  const confirm = async ({ cache, what }: Asking) => {
    try {
      if (what === 'password') setMade((await cachesApi.resetPassword(cache.name)).data);
      else await cachesApi.remove(cache.name);
      setAsking(null);
      await load();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  };

  return (
    <Page>
      <PageHeader
        title="Caches"
        description="Valkey 9.1, which speaks Redis OSS's protocol, as AWS ElastiCache gives it: a cache of your own, its memory the plan's, the least recently used keys going past it, nothing kept on disk. Reached over TLS by your functions, whatever their internet access, and from your machine."
        actions={
          mayCreate &&
          !naming && (
            <button type="button" className="btn btn-primary" onClick={() => setNaming(true)}>
              <Icon name="plus" />
              Create cache
            </button>
          )
        }
      />
      {naming && (
        <form onSubmit={create} className="card mb-6 space-y-3" aria-label="New cache">
          <label htmlFor="cache-name" className="block text-sm font-medium text-gray-700">
            Name
          </label>
          <input id="cache-name" className="input max-w-sm font-mono" maxLength={40} value={name} onChange={(e) => setName(e.target.value.trim())} autoFocus />
          <p className={`text-xs ${problem && name !== '' ? 'text-amber-900' : 'text-gray-500'}`}>
            {problem && name !== '' ? problem : 'Lower-case letters, digits and hyphens: your name for it, which the server never sees.'}
          </p>
          <div className="flex gap-3">
            <button type="submit" className="btn btn-primary" disabled={creating || !!problem}>
              {creating ? 'Creating…' : 'Create'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setNaming(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {made && <AddressOnce made={made} onDone={() => setMade(null)} />}
      {error && (
        <p role="alert" className="mb-4 text-red-700">
          {error}
        </p>
      )}
      <section className="overflow-hidden rounded-lg border border-line bg-white shadow-sm" aria-label="The account's caches">
        {caches === null && !error ? (
          <p className="px-4 py-10 text-center text-gray-500">Loading…</p>
        ) : caches?.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <div className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-blue-50 text-blue-600">
              <Icon name="caches" size={20} />
            </div>
            <h2 className="text-base font-semibold text-ink">No caches yet</h2>
            <p className="mx-auto mt-1 max-w-md text-gray-600">
              {mayCreate ? 'Create one here, or from your terminal with ' : 'Owners and developers make them here, or from a terminal with '}
              <code className="font-mono text-[13px]">ff caches create</code>.
            </p>
          </div>
        ) : (
          caches && (
            <div className="relative overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-gray-50/70 text-xs text-gray-500">
                  <tr className="border-b border-line">
                    <th scope="col" className="px-3.5 py-2.5 font-medium">Name</th>
                    <th scope="col" className="px-3.5 py-2.5 font-medium">Status</th>
                    <th scope="col" className="px-3.5 py-2.5 text-right font-medium">Memory</th>
                    <th scope="col" className="hidden px-3.5 py-2.5 text-right font-medium md:table-cell">Connections</th>
                    <th scope="col" className="hidden px-3.5 py-2.5 font-medium md:table-cell">Created</th>
                    {writer && (
                      <th scope="col" className="px-3.5 py-2.5">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {caches.map((cache) => {
                    const status = STATUS_INFO[cache.status];
                    return (
                      <tr key={cache.name} className="hover:bg-gray-50/70">
                        <td className="px-3.5 py-3">
                          <div className="font-semibold text-ink">{cache.name}</div>
                          <div className="font-mono text-xs break-all text-gray-500">{cache.address}</div>
                          <LastDay name={cache.name} />
                        </td>
                        <td className="px-3.5 py-3">
                          <StatusPill tone={status.tone} label={status.label} title={status.title} />
                        </td>
                        <td className="px-3.5 py-3 text-right whitespace-nowrap tabular-nums">
                          <MemoryUse cache={cache} />
                        </td>
                        <td className="hidden px-3.5 py-3 text-right whitespace-nowrap tabular-nums md:table-cell">{cache.currConnections ?? '–'}</td>
                        <td className="hidden px-3.5 py-3 whitespace-nowrap text-gray-600 md:table-cell">{formatWhen(cache.createdAt)}</td>
                        {writer && (
                          <td className="px-3.5 py-3 text-right whitespace-nowrap">
                            {asking?.cache.name === cache.name ? (
                              <span role="alertdialog" aria-label={asking.what === 'delete' ? `Delete ${cache.name}` : `A new password for ${cache.name}`} className="inline-flex flex-wrap items-center gap-2">
                                <span className="text-[13px] text-gray-700">
                                  {asking.what === 'delete' ? 'Delete it, with its keys?' : 'A new password? The old one logs no new connection in.'}
                                </span>
                                <button type="button" className="btn btn-primary" onClick={() => void confirm(asking)}>
                                  {asking.what === 'delete' ? 'Delete' : 'Make it'}
                                </button>
                                <button type="button" className="btn btn-secondary" onClick={() => setAsking(null)}>
                                  Keep it
                                </button>
                              </span>
                            ) : (
                              <span className="inline-flex gap-1">
                                {active && (
                                  <Link
                                    to={`/alarms?cache=${encodeURIComponent(cache.name)}`}
                                    aria-label={`An alarm on ${cache.name}`}
                                    className="rounded-md px-2 py-1 text-[13px] font-medium text-gray-500 hover:bg-gray-100 hover:text-ink"
                                  >
                                    Add an alarm
                                  </Link>
                                )}
                                {active && (
                                  <button
                                    type="button"
                                    onClick={() => setAsking({ cache, what: 'password' })}
                                    aria-label={`A new password for ${cache.name}`}
                                    className="rounded-md px-2 py-1 text-[13px] font-medium text-gray-500 hover:bg-gray-100 hover:text-ink"
                                  >
                                    New password
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => setAsking({ cache, what: 'delete' })}
                                  aria-label={`Delete ${cache.name}`}
                                  className="rounded-md px-2 py-1 text-[13px] font-medium text-gray-500 hover:bg-red-50 hover:text-red-700"
                                >
                                  Delete
                                </button>
                              </span>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}
      </section>
    </Page>
  );
};

export default Caches;
