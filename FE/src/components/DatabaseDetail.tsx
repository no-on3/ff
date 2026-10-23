import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatWhen } from '../lib/accounts';
import { STATUS_INFO, formatSize, measuredHours, storageShare } from '../lib/databases';
import { apiErrorMessage } from '../lib/functions';
import { can } from '../lib/session';
import { Alarm, Database, DatabaseMetrics, DatabaseWithPassword, alarmsApi, databasesApi } from '../services/api';
import { useSession } from '../session/session';
import { StateBadge } from './Alarms';
import { ConnectionOnce } from './Databases';
import { KeyNumber, KeyNumbers } from './KeyNumbers';
import { Page, PageHeader } from './Page';
import { Callout, Panel } from './Panel';
import StatusPill from './StatusPill';

/** A fact of how to connect: its name, and its value in code. */
const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
    <dt className="text-[13px] text-gray-600">{label}</dt>
    <dd className="m-0 min-w-0 break-all font-mono text-[13px] text-ink">{children}</dd>
  </div>
);

/** A database's alarms: each one's state and name, and where to set them. */
const DatabaseAlarms: React.FC<{ databaseId: string; mayChange: boolean }> = ({ databaseId, mayChange }) => {
  const [alarms, setAlarms] = useState<Alarm[] | null>(null);
  useEffect(() => {
    alarmsApi
      .list()
      .then(({ data }) => setAlarms(data.filter((alarm) => alarm.databaseId === databaseId)))
      .catch(() => setAlarms(null));
  }, [databaseId]);
  if (alarms === null) return null;
  return (
    <Panel
      aria-label="Alarms"
      title="Alarms"
      className="self-start"
      description="On its sessions or its storage, judged hour by hour."
      actions={
        mayChange && (
          <Link to={`/alarms?database=${databaseId}`} className="text-[13px]">
            Add one
          </Link>
        )
      }
    >
      {alarms.length === 0 ? (
        <p className="text-[13px] text-gray-600">None watches this database.</p>
      ) : (
        <ul className="space-y-2.5">
          {alarms.map((alarm) => (
            <li key={alarm.id} data-alarm={alarm.id} className="flex items-center gap-2 text-[13px]">
              <StateBadge state={alarm.state} /> <span className="min-w-0 truncate text-gray-800">{alarm.name}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
};

/**
 * A database's page (ADR 0008): how to reach it, its storage and sessions now
 * and over the last hours, its alarms; for owners and developers, a new
 * password, shown once, and deleting it with its data.
 */
const DatabaseDetail: React.FC = () => {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { account } = useSession();
  const [database, setDatabase] = useState<Database | null>(null);
  const [metrics, setMetrics] = useState<DatabaseMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<DatabaseWithPassword | null>(null);
  const [confirming, setConfirming] = useState<'password' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDatabase((await databasesApi.get(id)).data);
      setError(null);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
    databasesApi
      .metrics(id)
      .then(({ data }) => setMetrics(data))
      .catch(() => setMetrics(null));
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!account) return null;
  if (error && !database) {
    return (
      <Page>
        <PageHeader title="Database" crumbs={[{ label: 'Databases', to: '/databases' }]} />
        <p role="alert" className="text-red-700">
          {error}
        </p>
      </Page>
    );
  }
  if (!database) return <Page>Loading…</Page>;

  const writer = can(account.role, 'change databases');
  const status = STATUS_INFO[database.status];
  const share = storageShare(database);
  const hours = metrics ? measuredHours(metrics, 12) : [];

  const newPassword = async () => {
    setBusy(true);
    try {
      setMade((await databasesApi.resetPassword(database.id)).data);
      setConfirming(null);
      await load();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await databasesApi.remove(database.id);
      navigate('/databases');
    } catch (failure) {
      setError(apiErrorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title={database.name}
        crumbs={[{ label: 'Databases', to: '/databases' }]}
        aside={<StatusPill tone={status.tone} label={status.label} title={status.title} />}
        description="PostgreSQL 18, its user the database's owner, over TLS only."
        actions={
          writer &&
          !confirming && (
            <>
              {account.status === 'active' && (
                <button type="button" className="btn btn-secondary" onClick={() => setConfirming('password')}>
                  New password
                </button>
              )}
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming('delete')}>
                Delete
              </button>
            </>
          )
        }
      />
      {confirming && (
        <div role="alertdialog" aria-label={confirming === 'password' ? 'A new password' : `Delete ${database.name}`} className="card mb-6 space-y-3">
          <p className="text-gray-800">
            {confirming === 'password'
              ? 'The old password stops working for new sessions; those under way keep theirs. The new one is shown once.'
              : 'Its sessions end, and the database and its user are dropped, with their data. Nothing can bring it back.'}
          </p>
          <div className="flex gap-3">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void (confirming === 'password' ? newPassword() : remove())}>
              {confirming === 'password' ? 'Make a new password' : 'Delete, with its data'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {made && <ConnectionOnce made={made} onDone={() => setMade(null)} />}
      {error && (
        <p role="alert" className="mb-4 text-red-700">
          {error}
        </p>
      )}
      {database.status === 'read_only' && (
        <Callout tone="warning" role="status" title="Past its plan's storage: its new sessions start read-only" className="mb-6">
          A write answers SQLSTATE 25006 until it is back under, at the next hourly measure. A session may turn it off for itself,{' '}
          <code className="font-mono">SET default_transaction_read_only = off</code>, to delete what you no longer need. The storage above the plan's is billed.
        </Callout>
      )}
      {database.status === 'suspended' && (
        <Callout tone="danger" role="status" title="Its user can't log in" className="mb-6">
          {account.storageDisabledAt ? `FF turned this account's databases off: ${account.storageDisabledReason}` : 'The account is suspended.'} Its data are kept.
        </Callout>
      )}

      <KeyNumbers label="Its use now" className="mb-6 grid-cols-2 lg:grid-cols-4">
        <KeyNumber
          label="Storage"
          value={formatSize(database.sizeBytes)}
          note={<span>{share === null ? '' : `${share}% of `}the plan's {database.storageLimitMb.toLocaleString('en-US')} MB</span>}
        />
        <KeyNumber label="Sessions" value={database.connections ?? '–'} note={<span>of {database.connectionLimit} at most</span>} />
        <KeyNumber label="Password made" value={database.passwordSetAt ? formatWhen(database.passwordSetAt).split(',')[0] : '–'} note={<span>shown once, then never</span>} />
        <KeyNumber label="Created" value={formatWhen(database.createdAt).split(',')[0]} note={<span>{formatWhen(database.createdAt).split(', ')[1]}</span>} />
      </KeyNumbers>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <Panel title="Connect" description="With the password, shown when it was made or given a new one. Functions reach it whatever their account's internet access.">
            <dl className="space-y-2.5">
              <Fact label="Host">{database.host}</Fact>
              <Fact label="Port">{database.port}</Fact>
              <Fact label="Database">{database.database}</Fact>
              <Fact label="User">{database.user}</Fact>
              <Fact label="Without the password">{database.connectionUrl}</Fact>
            </dl>
            <p className="mt-4 text-[13px] text-gray-600">
              TLS only: <code className="font-mono">sslmode=require</code>. A function gets the string as a secret, <code className="font-mono">DATABASE_URL</code>{' '}
              as on AWS Lambda with RDS: set one when the password is shown, here or with <code className="font-mono">ff db password --secret-for</code>.
            </p>
          </Panel>
          <Panel title="The last hours" description="As measured each hour: the bill is made of these." flush>
            {hours.length === 0 ? (
              <p className="px-5 py-4 text-[13px] text-gray-600">No hour measured yet: the first measure comes within a minute of its creation.</p>
            ) : (
              <table className="w-full text-left text-[13px]">
                <thead className="bg-gray-50/70 text-xs text-gray-500">
                  <tr className="border-b border-line">
                    <th scope="col" className="px-5 py-2 font-medium">Hour</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Storage</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Sessions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {hours.map((hour) => (
                    <tr key={hour.at}>
                      <td className="px-5 py-2 whitespace-nowrap">{formatWhen(hour.at)}</td>
                      <td className="px-5 py-2 text-right tabular-nums">{formatSize(hour.sizeBytes)}</td>
                      <td className="px-5 py-2 text-right tabular-nums">{hour.connections}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
        <DatabaseAlarms databaseId={database.id} mayChange={writer && account.status === 'active'} />
      </div>
    </Page>
  );
};

export default DatabaseDetail;
