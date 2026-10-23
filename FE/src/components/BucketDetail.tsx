import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { formatWhen } from '../lib/accounts';
import { addresses, listCommand, measuredHours, storageNotice, total } from '../lib/buckets';
import { formatSize } from '../lib/databases';
import { apiErrorMessage } from '../lib/functions';
import { can } from '../lib/session';
import { Alarm, Bucket, BucketMetrics, alarmsApi, bucketsApi } from '../services/api';
import { useSession } from '../session/session';
import { StateBadge } from './Alarms';
import Copyable from './Copyable';
import { KeyNumber, KeyNumbers } from './KeyNumbers';
import { Page, PageHeader } from './Page';
import { Callout, Panel } from './Panel';
import StatusPill from './StatusPill';

/** The hours the page reads: the last day's, a point an hour. */
const HOURS = 24;

/** A fact of how to reach it: its name, and its value in code. */
const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
    <dt className="text-[13px] text-gray-600">{label}</dt>
    <dd className="m-0 min-w-0 break-all font-mono text-[13px] text-ink">{children}</dd>
  </div>
);

/** A bucket's alarms: each one's state and name, and where to set them. */
const BucketAlarms: React.FC<{ bucketName: string; mayChange: boolean }> = ({ bucketName, mayChange }) => {
  const [alarms, setAlarms] = useState<Alarm[] | null>(null);
  useEffect(() => {
    alarmsApi
      .list()
      .then(({ data }) => setAlarms(data.filter((alarm) => alarm.bucketName === bucketName)))
      .catch(() => setAlarms(null));
  }, [bucketName]);
  if (alarms === null) return null;
  return (
    <Panel
      aria-label="Alarms"
      title="Alarms"
      className="self-start"
      description="On what it holds, or its requests, errors and bytes, as CloudWatch has S3's."
      actions={
        mayChange && (
          <Link to={`/alarms?bucket=${encodeURIComponent(bucketName)}`} className="text-[13px]">
            Add one
          </Link>
        )
      }
    >
      {alarms.length === 0 ? (
        <p className="text-[13px] text-gray-600">None watches this bucket.</p>
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
 * A bucket's page (ADR 0009): where AWS's SDKs and CLI reach it, what it holds
 * and its requests over the last hours, as its hourly measures and the front
 * door's counts say, its alarms; for owners and developers, deleting it,
 * empty or with its files.
 */
const BucketDetail: React.FC = () => {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const { account } = useSession();
  const [bucket, setBucket] = useState<Bucket | null>(null);
  const [metrics, setMetrics] = useState<BucketMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<{ force: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setBucket((await bucketsApi.get(name)).data);
      setError(null);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
    const start = new Date(Date.now() - (HOURS - 1) * 3_600_000).toISOString();
    bucketsApi
      .metrics(name, { period: 3600, start })
      .then(({ data }) => setMetrics(data))
      .catch(() => setMetrics(null));
  }, [name]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!account) return null;
  if (error && !bucket) {
    return (
      <Page>
        <PageHeader title="Bucket" crumbs={[{ label: 'Buckets', to: '/buckets' }]} />
        <p role="alert" className="text-red-700">
          {error}
        </p>
      </Page>
    );
  }
  if (!bucket) return <Page>Loading…</Page>;

  const writer = can(account.role, 'change buckets');
  const notice = storageNotice(account);
  const where = addresses(bucket);
  const hours = metrics ? measuredHours(metrics, 12) : [];
  const requests = metrics ? total(metrics.metrics.AllRequests.Sum) : null;
  const failed = metrics ? total(metrics.metrics['4xxErrors'].Sum) + total(metrics.metrics['5xxErrors'].Sum) : null;

  const remove = async (force: boolean) => {
    setBusy(true);
    try {
      await bucketsApi.remove(bucket.name, force);
      navigate('/buckets');
    } catch (failure) {
      setError(apiErrorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title={bucket.name}
        crumbs={[{ label: 'Buckets', to: '/buckets' }]}
        aside={
          bucket.status === 'deleting' ? (
            <StatusPill tone="busy" label="Deleting" title="Being emptied and deleted: no S3 request reaches it" />
          ) : (
            <StatusPill tone="ok" label="Available" title="AWS's SDKs and CLI read and write it with the account's keys" />
          )
        }
        description="Its files, as AWS S3 keeps them: AWS's SDKs and CLI reach it at FF's S3 endpoint, path-style or at its own address."
        actions={
          writer &&
          !deleting && (
            <button type="button" className="btn btn-secondary" onClick={() => setDeleting({ force: false })}>
              Delete
            </button>
          )
        }
      />
      {deleting && (
        <div role="alertdialog" aria-label={`Delete ${bucket.name}`} className="card mb-6 space-y-3">
          <p className="text-gray-800">
            {deleting.force
              ? 'Every file in it is deleted, and every upload under way, then the bucket. Nothing can bring them back.'
              : 'An empty bucket is deleted, as S3 deletes one; one with files is refused, unless its files go too.'}{' '}
            Its name is free again at once.
          </p>
          <label className="inline-flex items-center gap-1.5 text-[13px] text-gray-700">
            <input type="checkbox" checked={deleting.force} onChange={(e) => setDeleting({ force: e.target.checked })} />
            Its files too
          </label>
          <div className="flex gap-3">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void remove(deleting.force)}>
              {deleting.force ? 'Delete, with its files' : 'Delete'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setDeleting(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mb-4 text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <Callout tone={notice.tone} role="status" title={notice.title} className="mb-6">
          {notice.text}
        </Callout>
      )}
      {account.storageDisabledAt && (
        <Callout tone="danger" role="status" title="FF turned this account's buckets off" className="mb-6">
          {account.storageDisabledReason} Its keys are refused until FF turns them on again. The files are kept.
        </Callout>
      )}

      <KeyNumbers label="Its use" className="mb-6 grid-cols-2 lg:grid-cols-4">
        <KeyNumber
          label="Storage"
          value={formatSize(bucket.sizeBytes)}
          note={<span>{bucket.measuredAt ? `as measured ${formatWhen(bucket.measuredAt)}` : 'measured within the hour'}</span>}
        />
        <KeyNumber label="Objects" value={bucket.objects === null ? '–' : bucket.objects.toLocaleString('en-US')} note={<span>at the same measure</span>} />
        <KeyNumber
          label="Requests"
          value={requests === null ? '–' : requests.toLocaleString('en-US')}
          note={<span>{failed === null ? 'in the last day' : `in the last day, ${failed.toLocaleString('en-US')} failed`}</span>}
        />
        <KeyNumber label="Created" value={formatWhen(bucket.createdAt).split(',')[0]} note={<span>{formatWhen(bucket.createdAt).split(', ')[1]}</span>} />
      </KeyNumbers>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        {/* A grid item grows to its content's width unless told not to: the command and addresses wrap instead. */}
        <div className="min-w-0 space-y-6">
          <Panel title="Reach it" description="With one of the account's access keys, made on the Buckets page; a function has a key of its own already.">
            <dl className="space-y-2.5">
              <Fact label="Endpoint">{bucket.endpoint}</Fact>
              <Fact label="Its address">{where.virtualHosted}</Fact>
              <Fact label="Path-style">{where.pathStyle}</Fact>
              <Fact label="Region">{bucket.region}</Fact>
            </dl>
            <div className="mt-4">
              <p className="mb-1.5 text-[13px] font-medium text-gray-700">The AWS CLI, its endpoint given</p>
              <Copyable value={listCommand(bucket)} label="the command" />
            </div>
            <p className="mt-4 text-[13px] text-gray-600">
              In a function, <code className="font-mono">new S3Client({'{}'})</code> and <code className="font-mono">boto3.client("s3")</code> need no setting: its pods have its
              own key, the region and the endpoint, as on AWS Lambda with a role.
            </p>
          </Panel>
          <Panel title="The last hours" description="As measured each hour, and its requests in that hour: the bill is made of these." flush>
            {hours.length === 0 ? (
              <p className="px-5 py-4 text-[13px] text-gray-600">No hour measured yet: the first measure comes within a minute of its creation.</p>
            ) : (
              <table className="w-full text-left text-[13px]">
                <thead className="bg-gray-50/70 text-xs text-gray-500">
                  <tr className="border-b border-line">
                    <th scope="col" className="px-5 py-2 font-medium">Hour</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Storage</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Objects</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Requests</th>
                    <th scope="col" className="px-5 py-2 text-right font-medium">Failed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {hours.map((hour) => (
                    <tr key={hour.at}>
                      <td className="px-5 py-2 whitespace-nowrap">{formatWhen(hour.at)}</td>
                      <td className="px-5 py-2 text-right tabular-nums">{formatSize(hour.sizeBytes)}</td>
                      <td className="px-5 py-2 text-right tabular-nums">{hour.objects.toLocaleString('en-US')}</td>
                      <td className="px-5 py-2 text-right tabular-nums">{hour.requests.toLocaleString('en-US')}</td>
                      <td className="px-5 py-2 text-right tabular-nums">{hour.errors.toLocaleString('en-US')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Panel>
        </div>
        <BucketAlarms bucketName={bucket.name} mayChange={writer && account.status === 'active'} />
      </div>
    </Page>
  );
};

export default BucketDetail;
