import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatWhen } from '../lib/accounts';
import { apiErrorMessage } from '../lib/functions';
import { bytesText, deadLetterText, messagesText, queueNameProblem } from '../lib/queues';
import { can } from '../lib/session';
import { Queue, queuesApi } from '../services/api';
import { useSession } from '../session/session';
import AccessKeys from './AccessKeys';
import Icon from './Icon';
import { Page, PageHeader } from './Page';
import { Callout } from './Panel';

/**
 * The account's queues, as Amazon SQS's standard queues (ADR 0010): every
 * member sees them; owners and developers of an active account make them;
 * the owners make the access keys AWS's SDKs and CLI use, which reach the
 * account's buckets and queues alike.
 */
const Queues: React.FC = () => {
  const { account } = useSession();
  const [queues, setQueues] = useState<Queue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setQueues((await queuesApi.list()).data);
      setError(null);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, account?.id]);

  if (!account) return null;
  const writer = can(account.role, 'change queues');
  const owner = can(account.role, 'manage the account');
  const open = account.status === 'active' && !account.storageDisabledAt;
  const problem = naming ? queueNameProblem(name) : null;
  const limit = account.plan.limits.queues;

  const create = (event: React.FormEvent) => {
    event.preventDefault();
    if (problem) return;
    setBusy(true);
    setError(null);
    void queuesApi
      .create(name)
      .then(async () => {
        setNaming(false);
        setName('');
        await load();
      })
      .catch((failure: unknown) => setError(apiErrorMessage(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <Page>
      <PageHeader
        title="Queues"
        description="Messages, as Amazon SQS's standard queues keep them: AWS's SDKs and CLI reach them at FF's SQS endpoint with one of the account's access keys, only the endpoint changed. Each message is kept until it is deleted, or its queue's retention ends."
        actions={
          writer &&
          open &&
          !naming && (
            <button type="button" className="btn btn-primary" onClick={() => setNaming(true)}>
              <Icon name="plus" />
              Create queue
            </button>
          )
        }
      />
      {account.storageDisabledAt && (
        <Callout tone="danger" role="alert" title="FF turned this account's queues off" className="mb-6">
          {account.storageDisabledReason} Its keys are refused, and no message is sent or received, until FF turns them on again. The messages are kept.
        </Callout>
      )}
      {naming && (
        <form onSubmit={create} className="card mb-6 space-y-3" aria-label="New queue">
          <label htmlFor="queue-name" className="block text-sm font-medium text-gray-700">
            Name
          </label>
          <input id="queue-name" className="input max-w-sm font-mono" maxLength={80} value={name} onChange={(e) => setName(e.target.value.trim())} autoFocus />
          <p className={`text-xs ${problem && name !== '' ? 'text-amber-900' : 'text-gray-500'}`}>
            {problem && name !== '' ? problem : "Letters, digits, hyphens and underscores, the account's own: it ends the queue's URL. Its attributes are SQS's defaults, which its page changes."}
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
      {error && (
        <p role="alert" className="mb-4 text-red-700">
          {error}
        </p>
      )}
      <section className="mb-3 overflow-hidden rounded-lg border border-line bg-white shadow-sm" aria-label="The account's queues">
        {queues === null && !error ? (
          <p className="px-4 py-10 text-center text-gray-500">Loading…</p>
        ) : queues?.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <div className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-blue-50 text-blue-600">
              <Icon name="queues" size={20} />
            </div>
            <h2 className="text-base font-semibold text-ink">No queues yet</h2>
            <p className="mx-auto mt-1 max-w-md text-gray-600">
              {writer && open ? 'Create one here, or with the AWS CLI: ' : 'Owners and developers make them here, or with the AWS CLI: '}
              <code className="font-mono text-[13px]">aws sqs create-queue --queue-name orders</code>.
            </p>
          </div>
        ) : (
          queues && (
            <div className="relative overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-gray-50/70 text-xs text-gray-500">
                  <tr className="border-b border-line">
                    <th scope="col" className="px-3.5 py-2.5 font-medium">Name</th>
                    <th scope="col" className="px-3.5 py-2.5 font-medium">Messages</th>
                    <th scope="col" className="px-3.5 py-2.5 text-right font-medium">Holding</th>
                    <th scope="col" className="hidden px-3.5 py-2.5 font-medium md:table-cell">Created</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {queues.map((queue) => (
                    <tr key={queue.name} className="hover:bg-gray-50/70">
                      <td className="px-3.5 py-3">
                        <Link to={`/queues/${queue.name}`} className="font-semibold text-ink hover:underline">
                          {queue.name}
                        </Link>
                        {queue.redrivePolicy && <span className="ml-2 text-xs text-gray-500">{deadLetterText(queue.redrivePolicy.deadLetterTargetArn, queues)}</span>}
                      </td>
                      <td className="px-3.5 py-3 whitespace-nowrap text-gray-700">{messagesText(queue.messages)}</td>
                      <td className="px-3.5 py-3 text-right whitespace-nowrap tabular-nums text-gray-700">{bytesText(queue.sizeBytes)}</td>
                      <td className="hidden px-3.5 py-3 whitespace-nowrap text-gray-600 md:table-cell">{formatWhen(queue.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </section>
      {queues && (
        <p className="mb-8 text-[13px] text-gray-500">
          {queues.length} of the {account.plan.name} plan&apos;s {limit} {limit === 1 ? 'queue' : 'queues'}; its messages hold {account.plan.limits.queueStorageMb} MB at most, functions&apos;
          calls that don&apos;t wait among them.
        </p>
      )}
      {owner && <AccessKeys queues={queues} open={open} />}
    </Page>
  );
};

export default Queues;
