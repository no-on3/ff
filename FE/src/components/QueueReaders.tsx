import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { eventSourceText, nameOfArn } from '../lib/event-sources';
import { apiErrorMessage } from '../lib/functions';
import { EventSource, Queue, eventSourcesApi, functionsApi } from '../services/api';
import { Panel } from './Panel';
import StatusPill from './StatusPill';

/**
 * The functions that read a queue, as AWS Lambda's event source mappings:
 * each with how it reads it, and a link to its page, where its mappings are
 * made and changed.
 */
export const QueueReaders: React.FC<{ queue: Queue }> = ({ queue }) => {
  const [readers, setReaders] = useState<Array<{ mapping: EventSource; functionId?: string }> | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    Promise.all([eventSourcesApi.forQueue(queue.arn), functionsApi.getAllFunctions()])
      .then(([mappings, functions]) => {
        if (!current) return;
        const ids = new Map(functions.data.map((fn) => [fn.name, fn.id]));
        setReaders(mappings.data.map((mapping) => ({ mapping, functionId: ids.get(nameOfArn(mapping.functionArn)) })));
      })
      .catch((err: unknown) => current && setError(apiErrorMessage(err)));
    return () => {
      current = false;
    };
  }, [queue.arn]);

  return (
    <Panel title="Read by" description="The functions that read this queue in batches, as AWS Lambda's event source mappings. A function's page has it read a queue, or stop.">
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      {readers === undefined && !error && <p className="text-[13px] text-gray-500">Loading…</p>}
      {readers?.length === 0 && <p className="text-[13px] text-gray-600">No function reads it: what is sent waits for a receive.</p>}
      {readers && readers.length > 0 && (
        <ul className="divide-y divide-gray-100" aria-label="The functions that read it">
          {readers.map(({ mapping, functionId }) => (
            <li key={mapping.uuid} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
              {functionId ? (
                <Link to={`/functions/${functionId}?tab=invocations`} className="font-semibold text-ink hover:underline">
                  {nameOfArn(mapping.functionArn)}
                </Link>
              ) : (
                <span className="font-semibold text-ink">{nameOfArn(mapping.functionArn)}</span>
              )}
              <StatusPill tone={mapping.state === 'Enabled' ? 'ok' : 'idle'} label={mapping.state === 'Enabled' ? 'Reading' : 'Disabled'} />
              <span className="text-[13px] text-gray-600">{eventSourceText(mapping)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
};
