import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { INVOCATION_STATUS_INFO, apiErrorMessage, sourceText } from '../lib/functions';
import { searchForFilter } from '../lib/logs';
import { BAR_TONES, elapsedText, qualifiedName, timeline, traceSummary } from '../lib/traces';
import { Trace, tracesApi } from '../services/api';
import { Page, PageHeader } from './Page';
import { Callout, Panel } from './Panel';
import StatusPill from './StatusPill';

/** One request's trail: the account's calls in a trace, by time, each with its bar on the trace's timeline. */
const TraceDetail: React.FC = () => {
  const { id = '' } = useParams<{ id: string }>();
  const [trace, setTrace] = useState<Trace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setTrace(null);
    setError(null);
    tracesApi
      .get(id)
      .then(({ data }) => current && setTrace(data))
      .catch((caught: unknown) => current && setError(apiErrorMessage(caught)));
    return () => {
      current = false;
    };
  }, [id]);

  const { rows, spanMs } = trace ? timeline(trace) : { rows: [], spanMs: 0 };

  return (
    <Page>
      <PageHeader
        crumbs={[{ label: 'Functions', to: '/functions' }]}
        title="Trace"
        aside={<code className="font-mono text-[13px] break-all text-gray-600">{trace?.traceId ?? id}</code>}
        description="One request's trail: the account's calls in this trace, by time, across the functions it reached."
      />
      {error && (
        <Callout tone="danger" role="alert" title="The trace can't be read">
          {error}
        </Callout>
      )}
      {!trace && !error && <p className="text-gray-500">Loading the trace…</p>}
      {trace && (
        <div className="space-y-4">
          {trace.truncated && (
            <Callout tone="warning" role="status">
              The trace has more calls than these, its first {trace.calls.length.toLocaleString('en-US')}.
            </Callout>
          )}
          <Panel flush title={traceSummary(trace, spanMs)} description={`From ${new Date(trace.calls[0].createdAt).toLocaleString()}`}>
            <ol className="divide-y divide-gray-100" aria-label="The trace's calls">
              {rows.map(({ call, offsetMs, left, width }) => {
                const info = INVOCATION_STATUS_INFO[call.status];
                const logs = searchForFilter({ range: 'all', q: '', requestId: call.requestId });
                return (
                  <li key={call.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span className="w-20 shrink-0 text-[13px] text-gray-500 tabular-nums" title="Its start after the first call's">
                        +{elapsedText(offsetMs)}
                      </span>
                      <StatusPill tone={info.tone} label={info.label} title={info.note} />
                      <Link to={`/functions/${call.functionId}?tab=invocations`} className="min-w-0 font-medium break-all">
                        {qualifiedName(call)}
                      </Link>
                      <span className="text-gray-500">{sourceText(call.source, call.attempt, call.trigger)}</span>
                      <span className="ml-auto text-[13px] text-gray-600 tabular-nums" title="Duration">
                        {elapsedText(call.duration)}
                      </span>
                    </div>
                    <div
                      className="relative mt-2 h-2 rounded-full bg-gray-100"
                      role="img"
                      aria-label={`From +${elapsedText(offsetMs)}, for ${elapsedText(call.duration)}, of the trace's ${elapsedText(spanMs)}`}
                    >
                      <div className={`absolute inset-y-0 rounded-full ${BAR_TONES[info.tone]}`} style={{ left: `${left}%`, width: `${width}%` }} />
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                      <span className="min-w-0 break-all">
                        Request <code className="font-mono text-gray-700">{call.requestId}</code>
                      </span>
                      <Link to={`/functions/${call.functionId}?${logs.toString()}`}>Its logs</Link>
                    </div>
                  </li>
                );
              })}
            </ol>
          </Panel>
        </div>
      )}
    </Page>
  );
};

export default TraceDetail;
