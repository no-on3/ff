import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BATCH_SIZE, BATCHING_WINDOW, EventSourceForm, MAXIMUM_CONCURRENCY, eventSourceBody, eventSourceForm, eventSourceText, nameOfArn } from '../lib/event-sources';
import { apiErrorMessage } from '../lib/functions';
import { EventSource, Function, Queue, eventSourcesApi, queuesApi } from '../services/api';
import { Callout, Panel } from './Panel';
import StatusPill from './StatusPill';

/**
 * The queues a function reads, as AWS Lambda's event source mappings for
 * SQS: FF calls it with batches of each one's messages, SQS's event, and
 * deletes what each call handled. Every member reads them; owners and
 * developers have it read a queue of the account, change how, disable a
 * mapping, or remove it, the messages staying in the queue.
 */
export const FunctionEventSources: React.FC<{ func: Function; mayChange: boolean }> = ({ func, mayChange }) => {
  const [mappings, setMappings] = useState<EventSource[] | undefined>(undefined);
  const [queues, setQueues] = useState<Queue[]>([]);
  /** The mapping being changed, 'new' for one being made, null for none. */
  const [editing, setEditing] = useState<EventSource | 'new' | null>(null);
  const [form, setForm] = useState<EventSourceForm>(eventSourceForm());
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMappings((await eventSourcesApi.forFunction(func.id)).data);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [func.id]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = async (mapping: EventSource | 'new') => {
    setForm(eventSourceForm(mapping === 'new' ? undefined : mapping));
    setError(null);
    setRemoving(null);
    setEditing(mapping);
    if (mapping !== 'new') return;
    try {
      setQueues((await queuesApi.list()).data);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  /** A call, then the list as the API has it; the API's refusal said, in its words. */
  const run = async (call: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await call();
      setEditing(null);
      setRemoving(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    const built = eventSourceBody(form);
    if ('problem' in built) return setError(built.problem);
    if (editing === 'new') {
      const queue = queues.find((candidate) => candidate.name === form.queue);
      if (!queue) return setError('Choose the queue it reads');
      void run(() => eventSourcesApi.create(func.id, { eventSourceArn: queue.arn, ...built.body }));
    } else if (editing) {
      void run(() => eventSourcesApi.update(editing.uuid, built.body));
    }
  };

  const reading = new Set((mappings ?? []).map((mapping) => nameOfArn(mapping.eventSourceArn)));
  const number = (field: 'batchSize' | 'window' | 'maximumConcurrency', label: string, min: number, max: number, placeholder?: string) => (
    <label className="flex flex-col gap-1 text-[13px] text-gray-700">
      {label}
      <input className="input" type="number" min={min} max={max} step={1} placeholder={placeholder} value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value })} />
    </label>
  );

  return (
    <Panel
      title="Queues it reads"
      description="Queues of the account this function reads in batches, as AWS Lambda's event source mappings: FF calls it with SQS's event, Records[], and deletes the messages each call handled. A call that fails keeps its batch, which comes back after the queue's visibility timeout, towards its dead-letter queue."
      actions={
        mayChange && mappings !== undefined && editing === null ? (
          <button type="button" className="btn btn-secondary" onClick={() => void open('new')}>
            Read a queue
          </button>
        ) : undefined
      }
    >
      {error && (
        <Callout tone="danger" role="alert" className="mb-4">
          {error}
        </Callout>
      )}
      {mappings === undefined && !error && <p className="text-[13px] text-gray-500">Loading…</p>}
      {mappings?.length === 0 && editing === null && <p className="text-[13px] text-gray-600">It reads no queue.</p>}
      {mappings && mappings.length > 0 && (
        <ul className="mb-2 divide-y divide-gray-100" aria-label="The queues it reads">
          {mappings.map((mapping) => {
            const queue = nameOfArn(mapping.eventSourceArn);
            return (
              <li key={mapping.uuid} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                <Link to={`/queues/${queue}`} className="font-semibold text-ink hover:underline">
                  {queue}
                </Link>
                <StatusPill tone={mapping.state === 'Enabled' ? 'ok' : 'idle'} label={mapping.state === 'Enabled' ? 'Reading' : 'Disabled'} />
                <span className="text-[13px] text-gray-600">{eventSourceText(mapping)}</span>
                {mayChange && editing === null && (
                  <span className="ml-auto flex flex-wrap gap-2">
                    {removing === mapping.uuid ? (
                      <>
                        <span className="self-center text-[13px] text-gray-700">Stop reading {queue}? Its messages stay.</span>
                        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => eventSourcesApi.remove(mapping.uuid))}>
                          Stop reading
                        </button>
                        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setRemoving(null)}>
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button type="button" className="btn btn-secondary" onClick={() => void open(mapping)}>
                          Change
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={busy}
                          onClick={() => void run(() => eventSourcesApi.update(mapping.uuid, { enabled: mapping.state !== 'Enabled' }))}
                        >
                          {mapping.state === 'Enabled' ? 'Disable' : 'Enable'}
                        </button>
                        <button type="button" className="btn btn-secondary" onClick={() => setRemoving(mapping.uuid)}>
                          Remove
                        </button>
                      </>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {editing !== null && (
        <form onSubmit={save} className="space-y-4" aria-label={editing === 'new' ? 'A queue to read' : `How it reads ${nameOfArn(editing.eventSourceArn)}`}>
          <div className="grid gap-4 sm:grid-cols-2">
            {editing === 'new' ? (
              <label className="flex flex-col gap-1 text-[13px] text-gray-700">
                The queue
                <select className="input" value={form.queue} onChange={(e) => setForm({ ...form, queue: e.target.value })}>
                  <option value="">Choose one</option>
                  {queues
                    .filter((queue) => !reading.has(queue.name))
                    .map((queue) => (
                      <option key={queue.name} value={queue.name}>
                        {queue.name}
                      </option>
                    ))}
                </select>
                <span className="text-xs text-gray-500">Its visibility timeout must be at least the function&apos;s timeout, {func.timeout} s, as Lambda requires.</span>
              </label>
            ) : (
              <p className="self-end text-[13px] text-gray-700">
                The queue <span className="font-semibold">{nameOfArn(editing.eventSourceArn)}</span>
              </p>
            )}
            {number('batchSize', `Messages a batch, at most (${BATCH_SIZE.min} to ${BATCH_SIZE.max.toLocaleString('en-US')})`, BATCH_SIZE.min, BATCH_SIZE.max)}
            {number('window', `Batching window, in seconds (${BATCHING_WINDOW.min} to ${BATCHING_WINDOW.max}): how long to gather a batch`, BATCHING_WINDOW.min, BATCHING_WINDOW.max)}
            {number('maximumConcurrency', `Batches at once, at most (${MAXIMUM_CONCURRENCY.min} to ${MAXIMUM_CONCURRENCY.max.toLocaleString('en-US')})`, MAXIMUM_CONCURRENCY.min, MAXIMUM_CONCURRENCY.max, `As many as its instances, ${func.maxInstances}`)}
          </div>
          <label className="flex items-start gap-2 text-[13px] text-gray-700">
            <input type="checkbox" className="mt-0.5" checked={form.reportFailures} onChange={(e) => setForm({ ...form, reportFailures: e.target.checked })} />
            <span>
              Its answer names the messages that failed, <code className="font-mono text-[12px]">{'{"batchItemFailures": [{"itemIdentifier": "<messageId>"}]}'}</code>, and the others are deleted
              (ReportBatchItemFailures)
            </span>
          </label>
          <label className="flex items-center gap-2 text-[13px] text-gray-700">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            Enabled: unchecked, nothing is read, and the messages wait in the queue
          </label>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : editing === 'new' ? 'Read it' : 'Save'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                setEditing(null);
                setError(null);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
};
