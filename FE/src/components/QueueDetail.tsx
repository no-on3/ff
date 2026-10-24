import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { formatWhen } from '../lib/accounts';
import { apiErrorMessage } from '../lib/functions';
import { QUEUE_ATTRIBUTES, QueueForm, bytesText, cliCommands, durationText, endpointOf, nameOfQueueArn, queueAttributesBody, queueForm } from '../lib/queues';
import { can } from '../lib/session';
import { Queue, ReceivedMessage, queuesApi } from '../services/api';
import { useSession } from '../session/session';
import Copyable from './Copyable';
import { KeyNumber, KeyNumbers } from './KeyNumbers';
import { Page, PageHeader } from './Page';
import { Callout, Panel } from './Panel';
import { QueueReaders } from './QueueReaders';
import StatusPill from './StatusPill';

/** A fact of how to reach it: its name, and its value in code. */
const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
    <dt className="text-[13px] text-gray-600">{label}</dt>
    <dd className="m-0 min-w-0 break-all font-mono text-[13px] text-ink">{children}</dd>
  </div>
);

/** An attribute as the page says it: seconds as a duration, bytes as a size. */
const valueText = (unit: string, value: number) => (unit === 'bytes' ? bytesText(value) : durationText(value));

/** Its attributes: as they are, or the form that changes them. */
const Attributes: React.FC<{ queue: Queue; others: Queue[]; mayChange: boolean; onSaved(queue: Queue): void }> = ({ queue, others, mayChange, onSaved }) => {
  const [form, setForm] = useState<QueueForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    const built = queueAttributesBody(form, queue);
    if ('problem' in built) return setProblem(built.problem);
    setBusy(true);
    setProblem(null);
    void queuesApi
      .update(queue.name, built.body)
      .then(({ data }) => {
        onSaved(data);
        setForm(null);
      })
      .catch((failure: unknown) => setProblem(apiErrorMessage(failure)))
      .finally(() => setBusy(false));
  };

  return (
    <Panel
      title="Attributes"
      description="SQS's, with SQS's defaults until they are changed."
      actions={
        mayChange &&
        !form && (
          <button type="button" className="text-[13px] font-medium text-blue-700 hover:underline" onClick={() => setForm(queueForm(queue))}>
            Change
          </button>
        )
      }
    >
      {form ? (
        <form onSubmit={save} className="space-y-3" aria-label="The queue's attributes">
          {QUEUE_ATTRIBUTES.map(({ field, label, unit, help, min, max }) => (
            <label key={field} className="grid gap-1 text-[13px] text-gray-700 sm:grid-cols-[10rem_8rem_1fr] sm:items-center">
              <span>{label}</span>
              <input
                className="input font-mono"
                inputMode="numeric"
                value={form.values[field]}
                aria-describedby={`${field}-help`}
                onChange={(e) => setForm({ ...form, values: { ...form.values, [field]: e.target.value.trim() } })}
              />
              <span id={`${field}-help`} className="text-xs text-gray-500">
                {unit}, {min} to {max}: {help}
              </span>
            </label>
          ))}
          <label className="grid gap-1 text-[13px] text-gray-700 sm:grid-cols-[10rem_1fr] sm:items-center">
            <span>Dead-letter queue</span>
            <select className="select max-w-xs" value={form.deadLetterQueue} onChange={(e) => setForm({ ...form, deadLetterQueue: e.target.value })}>
              <option value="">None</option>
              {others.map((other) => (
                <option key={other.name} value={other.name}>
                  {other.name}
                </option>
              ))}
            </select>
          </label>
          {form.deadLetterQueue && (
            <label className="grid gap-1 text-[13px] text-gray-700 sm:grid-cols-[10rem_8rem_1fr] sm:items-center">
              <span>Received at most</span>
              <input className="input font-mono" inputMode="numeric" value={form.maxReceiveCount} onChange={(e) => setForm({ ...form, maxReceiveCount: e.target.value.trim() })} />
              <span className="text-xs text-gray-500">times, 1 to 1,000: a message received more often goes to the dead-letter queue</span>
            </label>
          )}
          {problem && (
            <p role="alert" className="text-[13px] text-red-700">
              {problem}
            </p>
          )}
          <div className="flex gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <dl className="space-y-2.5">
          {QUEUE_ATTRIBUTES.map(({ field, label, unit }) => (
            <div key={field} className="grid gap-1 sm:grid-cols-[10rem_1fr]">
              <dt className="text-[13px] text-gray-600">{label}</dt>
              <dd className="m-0 text-[13px] text-ink">{valueText(unit, queue[field])}</dd>
            </div>
          ))}
          <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
            <dt className="text-[13px] text-gray-600">Dead-letter queue</dt>
            <dd className="m-0 text-[13px] text-ink">
              {queue.redrivePolicy
                ? `${nameOfQueueArn(queue.redrivePolicy.deadLetterTargetArn)}, after ${queue.redrivePolicy.maxReceiveCount} ${queue.redrivePolicy.maxReceiveCount === 1 ? 'receive' : 'receives'}${
                    others.some((other) => other.arn === queue.redrivePolicy?.deadLetterTargetArn) ? '' : ': gone since, so none moves, and its messages keep coming back'
                  }`
                : 'None: a message comes back as often as it is received'}
            </dd>
          </div>
        </dl>
      )}
    </Panel>
  );
};

/** Sending and receiving, to debug the queue, as SQS's operations do. */
const Messages: React.FC<{ queue: Queue; open: boolean; onChanged(): void }> = ({ queue, open, onChanged }) => {
  const [body, setBody] = useState('');
  const [received, setReceived] = useState<ReceivedMessage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await action();
      onChanged();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const send = (event: React.FormEvent) => {
    event.preventDefault();
    void act(async () => {
      const { data } = await queuesApi.send(queue.name, { body });
      setBody('');
      setNote(`Sent: message ${data.messageId}.`);
    });
  };
  const receive = () =>
    act(async () => {
      const { data } = await queuesApi.receive(queue.name, { maxMessages: 10, waitTimeSeconds: 2 });
      setReceived(data);
      if (data.length === 0) setNote('No message to receive: none is waiting, or those there are in flight or delayed.');
    });
  const remove = (message: ReceivedMessage) =>
    act(async () => {
      await queuesApi.deleteMessage(queue.name, message.receiptHandle);
      setReceived((list) => (list ?? []).filter((each) => each.receiptHandle !== message.receiptHandle));
      setNote(`Deleted: message ${message.messageId}.`);
    });

  return (
    <Panel
      title="Messages"
      description={`To debug the queue. Receiving here is as any receive: each message received is hidden for ${durationText(queue.visibilityTimeout)}, and its receive counted, which a dead-letter queue counts too.`}
    >
      {open && (
        <form onSubmit={send} className="mb-4 space-y-2" aria-label="Send a message">
          <label htmlFor="message-body" className="block text-[13px] font-medium text-gray-700">
            A message&apos;s body
          </label>
          <textarea id="message-body" className="input min-h-20 w-full font-mono text-[13px]" value={body} onChange={(e) => setBody(e.target.value)} placeholder='{"order": 42}' />
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn btn-secondary" disabled={busy || body === ''}>
              Send
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void receive()}>
              Receive up to ten
            </button>
          </div>
        </form>
      )}
      {note && (
        <p role="status" className="mb-3 text-[13px] text-gray-700">
          {note}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-[13px] text-red-700">
          {error}
        </p>
      )}
      {received && received.length > 0 && (
        <ul className="divide-y divide-gray-100" aria-label="Messages received">
          {received.map((message) => (
            <li key={message.receiptHandle} className="space-y-1.5 py-3">
              <pre className="overflow-x-auto rounded-md bg-gray-50 p-2.5 font-mono text-[13px] whitespace-pre-wrap break-all text-ink">{message.body}</pre>
              <p className="text-xs text-gray-500">
                Received {message.receiveCount === 1 ? 'once' : `${message.receiveCount} times`}, sent {formatWhen(message.sentAt)} by {message.senderId}
                {Object.keys(message.attributes).length > 0 &&
                  `; ${Object.entries(message.attributes)
                    .map(([name, value]) => `${name} = ${value.stringValue ?? `(${value.dataType})`}`)
                    .join(', ')}`}
              </p>
              <button type="button" className="text-[13px] font-medium text-gray-600 hover:text-red-700" disabled={busy} onClick={() => void remove(message)} aria-label={`Delete message ${message.messageId}`}>
                Delete it
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
};

/** A queue's page: its addresses, its messages, its attributes, and, for those who may change it, its messages to debug it. */
const QueueDetail: React.FC = () => {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const { account } = useSession();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [others, setOthers] = useState<Queue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'purge' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [one, all] = await Promise.all([queuesApi.get(name), queuesApi.list()]);
      setQueue(one.data);
      setOthers(all.data.filter((each) => each.name !== name));
      setError(null);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  }, [name]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!account) return null;
  if (error && !queue) {
    return (
      <Page>
        <p role="alert" className="text-red-700">
          {error}
        </p>
      </Page>
    );
  }
  if (!queue) return <Page>Loading…</Page>;

  const writer = can(account.role, 'change queues');
  const open = account.status === 'active' && !account.storageDisabledAt;
  const confirm = async () => {
    setBusy(true);
    try {
      if (confirming === 'delete') {
        await queuesApi.remove(queue.name);
        navigate('/queues');
        return;
      }
      await queuesApi.purge(queue.name);
      setConfirming(null);
      await load();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader
        title={queue.name}
        crumbs={[{ label: 'Queues', to: '/queues' }]}
        aside={<StatusPill tone="ok" label="Available" title="AWS's SDKs and CLI send and receive its messages with the account's keys" />}
        description="A standard queue, as Amazon SQS's: each message is received at least once, in about the order it was sent."
        actions={
          writer &&
          !confirming && (
            <div className="flex gap-2">
              <button type="button" className="btn btn-secondary" onClick={() => void load()}>
                Refresh
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming('purge')}>
                Purge
              </button>
              <button type="button" className="btn btn-secondary" onClick={() => setConfirming('delete')}>
                Delete
              </button>
            </div>
          )
        }
      />
      {confirming && (
        <div role="alertdialog" aria-label={confirming === 'delete' ? `Delete ${queue.name}` : `Purge ${queue.name}`} className="card mb-6 space-y-3">
          <p className="text-gray-800">
            {confirming === 'delete'
              ? 'The queue is deleted, with every message in it, as SQS deletes one: nothing can bring them back. What sends to it is refused.'
              : 'Every message in it is deleted, as SQS purges a queue: nothing can bring them back. The queue stays.'}
          </p>
          <div className="flex gap-3">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirm()}>
              {confirming === 'delete' ? 'Delete the queue' : 'Purge its messages'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(null)}>
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
      {account.storageDisabledAt && (
        <Callout tone="danger" role="status" title="FF turned this account's queues off" className="mb-6">
          {account.storageDisabledReason} Its keys are refused until FF turns them on again. The messages are kept.
        </Callout>
      )}

      <KeyNumbers label="Its messages" className="mb-6 grid-cols-2 lg:grid-cols-4">
        <KeyNumber label="Waiting" value={queue.messages.available.toLocaleString('en-US')} note={<span>to be received now</span>} />
        <KeyNumber label="In flight" value={queue.messages.inFlight.toLocaleString('en-US')} note={<span>received, hidden for their visibility timeout</span>} />
        <KeyNumber label="Delayed" value={queue.messages.delayed.toLocaleString('en-US')} note={<span>waiting for their delay</span>} />
        <KeyNumber label="Holding" value={bytesText(queue.sizeBytes)} note={<span>as the plan counts its messages</span>} />
      </KeyNumbers>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        {/* A grid item grows to its content's width unless told not to: the commands and addresses wrap instead. */}
        <div className="min-w-0 space-y-6">
          <Panel title="Reach it" description="With one of the account's access keys; a function has a key of its own already.">
            <dl className="space-y-2.5">
              <Fact label="URL">{queue.url}</Fact>
              <Fact label="ARN">{queue.arn}</Fact>
              <Fact label="Endpoint">{endpointOf(queue)}</Fact>
            </dl>
            <div className="mt-4">
              <p className="mb-1.5 text-[13px] font-medium text-gray-700">The AWS CLI, with AWS_ENDPOINT_URL_SQS set to the endpoint</p>
              <Copyable value={cliCommands(queue)} label="the commands" />
            </div>
            <p className="mt-4 text-[13px] text-gray-600">
              In a function, <code className="font-mono">new SQSClient({'{}'})</code> and <code className="font-mono">boto3.client("sqs")</code> need no setting: its pods have its
              own key, the region and the endpoint, as on AWS Lambda with a role. There, find the queue by its name (GetQueueUrl); AWS&apos;s SDK for JavaScript sends a queue&apos;s
              requests to its URL&apos;s host.
            </p>
          </Panel>
          {writer && <Messages queue={queue} open={open} onChanged={() => void load()} />}
        </div>
        <div className="min-w-0 space-y-6">
          <Attributes queue={queue} others={others} mayChange={writer} onSaved={setQueue} />
          <QueueReaders queue={queue} />
          <p className="text-[13px] text-gray-500">Created {formatWhen(queue.createdAt)}; changed {formatWhen(queue.updatedAt)}.</p>
        </div>
      </div>
    </Page>
  );
};

export default QueueDetail;
