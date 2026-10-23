import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatWhen } from '../lib/accounts';
import { DEFAULT_SECRET, STATUS_INFO, databaseNameProblem, formatSize, psqlCommand, storageShare } from '../lib/databases';
import { secretProblem } from '../lib/environment';
import { apiErrorMessage } from '../lib/functions';
import { can } from '../lib/session';
import { Database, DatabaseWithPassword, Function, databasesApi, functionsApi, secretsApi } from '../services/api';
import { useSession } from '../session/session';
import Copyable from './Copyable';
import Icon from './Icon';
import { Page, PageHeader } from './Page';
import { Callout, Panel } from './Panel';
import StatusPill from './StatusPill';

/**
 * A database's password and connection string, this once: FF keeps no copy.
 * It can go straight into a function's secret, which the function reads as
 * process.env.DATABASE_URL, as on AWS Lambda with RDS.
 */
export const ConnectionOnce: React.FC<{ made: DatabaseWithPassword; onDone(): void }> = ({ made, onDone }) => {
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
    const problem = functionId ? secretProblem(name, made.connectionString, []) : 'Choose a function';
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      await secretsApi.change(functionId, { [name]: made.connectionString });
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
          <p className="mb-1.5 text-[13px] font-medium text-gray-700">The connection string, with its password</p>
          <Copyable value={made.connectionString} label="the connection string" testId="connection-string" />
        </div>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-gray-700">From your terminal</p>
          <Copyable value={psqlCommand(made.connectionString)} label="the psql command" />
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

/** Its storage: the size, and the share of the plan's, read-only past it. */
export const StorageUse: React.FC<{ database: Database }> = ({ database }) => {
  const share = storageShare(database);
  return (
    <span title={`${formatSize(database.sizeBytes)} of the plan's ${database.storageLimitMb.toLocaleString('en-US')} MB`}>
      {formatSize(database.sizeBytes)}
      {share !== null && <span className={`ml-1.5 text-xs ${share >= 80 ? 'text-amber-800' : 'text-gray-500'}`}>{share}%</span>}
    </span>
  );
};

/**
 * The account's PostgreSQL databases, as AWS RDS gives them (ADR 0008):
 * every member sees them, their size and sessions now; owners and developers
 * of an active account make them, their connection string shown once, and
 * delete them, with their data.
 */
const Databases: React.FC = () => {
  const { account } = useSession();
  const [databases, setDatabases] = useState<Database[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<DatabaseWithPassword | null>(null);
  const [deleting, setDeleting] = useState<Database | null>(null);

  const load = useCallback(async () => {
    try {
      setDatabases((await databasesApi.list()).data);
      setError(null);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, account?.id]);

  if (!account) return null;
  const writer = can(account.role, 'change databases');
  const mayCreate = writer && account.status === 'active' && !account.storageDisabledAt;
  const problem = naming ? databaseNameProblem(name) : null;

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (problem) return;
    setCreating(true);
    setError(null);
    try {
      setMade((await databasesApi.create(name)).data);
      setNaming(false);
      setName('');
      await load();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setCreating(false);
    }
  };
  const remove = async (database: Database) => {
    try {
      await databasesApi.remove(database.id);
      setDeleting(null);
      await load();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  };

  return (
    <Page>
      <PageHeader
        title="Databases"
        description="PostgreSQL 18, as AWS RDS gives it: a database and its user, reached over TLS by your functions, whatever their internet access, and from your machine. Its storage is billed by the GB-month, 1 GB-month free each month."
        actions={
          mayCreate &&
          !naming && (
            <button type="button" className="btn btn-primary" onClick={() => setNaming(true)}>
              <Icon name="plus" />
              Create database
            </button>
          )
        }
      />
      {account.storageDisabledAt && (
        <Callout tone="danger" role="alert" title="FF turned this account's databases off" className="mb-6">
          {account.storageDisabledReason} Their users can't log in, and no database can be made, until FF turns them on again. Their data are kept.
        </Callout>
      )}
      {naming && (
        <form onSubmit={create} className="card mb-6 space-y-3" aria-label="New database">
          <label htmlFor="database-name" className="block text-sm font-medium text-gray-700">
            Name
          </label>
          <input id="database-name" className="input max-w-sm font-mono" maxLength={63} value={name} onChange={(e) => setName(e.target.value.trim())} autoFocus />
          <p className={`text-xs ${problem && name !== '' ? 'text-amber-900' : 'text-gray-500'}`}>
            {problem && name !== '' ? problem : "Lower-case letters, digits and hyphens: your name for it, which the server never sees."}
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
      {made && <ConnectionOnce made={made} onDone={() => setMade(null)} />}
      {error && (
        <p role="alert" className="mb-4 text-red-700">
          {error}
        </p>
      )}
      <section className="overflow-hidden rounded-lg border border-line bg-white shadow-sm" aria-label="The account's databases">
        {databases === null && !error ? (
          <p className="px-4 py-10 text-center text-gray-500">Loading…</p>
        ) : databases?.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <div className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-blue-50 text-blue-600">
              <Icon name="databases" size={20} />
            </div>
            <h2 className="text-base font-semibold text-ink">No databases yet</h2>
            <p className="mx-auto mt-1 max-w-md text-gray-600">
              {mayCreate ? 'Create one here, or from your terminal with ' : 'Owners and developers make them here, or from a terminal with '}
              <code className="font-mono text-[13px]">ff db create</code>.
            </p>
          </div>
        ) : (
          databases && (
            <div className="relative overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-gray-50/70 text-xs text-gray-500">
                  <tr className="border-b border-line">
                    <th scope="col" className="px-3.5 py-2.5 font-medium">Name</th>
                    <th scope="col" className="px-3.5 py-2.5 font-medium">Status</th>
                    <th scope="col" className="px-3.5 py-2.5 text-right font-medium">Storage</th>
                    <th scope="col" className="hidden px-3.5 py-2.5 text-right font-medium md:table-cell">Sessions</th>
                    <th scope="col" className="hidden px-3.5 py-2.5 font-medium md:table-cell">Created</th>
                    {writer && (
                      <th scope="col" className="px-3.5 py-2.5">
                        <span className="sr-only">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {databases.map((database) => {
                    const status = STATUS_INFO[database.status];
                    return (
                      <tr key={database.id} className="hover:bg-gray-50/70">
                        <td className="px-3.5 py-3">
                          <Link to={`/databases/${database.id}`} className="font-semibold text-ink hover:text-blue-600">
                            {database.name}
                          </Link>
                          <div className="font-mono text-xs text-gray-500">{database.database}</div>
                        </td>
                        <td className="px-3.5 py-3">
                          <StatusPill tone={status.tone} label={status.label} title={status.title} />
                        </td>
                        <td className="px-3.5 py-3 text-right whitespace-nowrap tabular-nums">
                          <StorageUse database={database} />
                        </td>
                        <td className="hidden px-3.5 py-3 text-right whitespace-nowrap tabular-nums md:table-cell">
                          {database.connections ?? '–'} of {database.connectionLimit}
                        </td>
                        <td className="hidden px-3.5 py-3 whitespace-nowrap text-gray-600 md:table-cell">{formatWhen(database.createdAt)}</td>
                        {writer && (
                          <td className="px-3.5 py-3 text-right whitespace-nowrap">
                            {deleting?.id === database.id ? (
                              <span role="alertdialog" aria-label={`Delete ${database.name}`} className="inline-flex flex-wrap items-center gap-2">
                                <span className="text-[13px] text-gray-700">Delete it, with its data?</span>
                                <button type="button" className="btn btn-primary" onClick={() => void remove(database)}>
                                  Delete
                                </button>
                                <button type="button" className="btn btn-secondary" onClick={() => setDeleting(null)}>
                                  Keep it
                                </button>
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => setDeleting(database)}
                                aria-label={`Delete ${database.name}`}
                                className="rounded-md px-2 py-1 text-[13px] font-medium text-gray-500 hover:bg-red-50 hover:text-red-700"
                              >
                                Delete
                              </button>
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

export default Databases;
