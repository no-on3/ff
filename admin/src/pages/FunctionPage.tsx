import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { supportApi } from '../api';
import { Fact, Table } from '../components/Facts';
import ReasonDialog from '../components/ReasonDialog';
import { EmptyState, ErrorState, Loading } from '../components/States';
import StatusBadge from '../components/StatusBadge';
import { ownersOf } from '../lib/accounts';
import { apiErrorMessage, notAnOperator } from '../lib/errors';
import { Call, CallData, FunctionPage as Page, LogLine, Look, TRUNCATED, callValue, lookDialog, milliseconds, outcome } from '../lib/support';
import { whenUtc } from '../lib/time';

/** What a look showed: kept on the page until another replaces it. */
type Shown =
  | { kind: 'code'; runtime: string; code: string }
  | { kind: 'call'; data: CallData }
  | { kind: 'logs'; callId?: string; lines: LogLine[] };

const Value: React.FC<{ label: string; value: unknown; truncated: boolean }> = ({ label, value, truncated }) => (
  <div>
    <h3 className="text-sm font-medium text-gray-700">{label}</h3>
    <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-gray-50 p-2 text-sm">{callValue(value, truncated)}</pre>
    {truncated && <p className="mt-1 text-xs text-gray-500">{TRUNCATED}</p>}
  </div>
);

/**
 * A function, as support sees it: its settings, state and account, and its
 * recent calls and failures, without what went in or out. Its code, a call's
 * data and its logs come only for a reason, which the account's audit log
 * keeps, as FF's look, for its owners to see.
 */
const FunctionPage: React.FC<{ email: string | undefined }> = ({ email }) => {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const asked = params.get('call');
  const [page, setPage] = useState<Page | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [look, setLook] = useState<Look | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);

  const load = useCallback(async () => {
    setFailure(null);
    try {
      setPage((await supportApi.functionPage(id)).data);
    } catch (error) {
      if (notAnOperator(error)) setRefused(true);
      else setFailure(apiErrorMessage(error));
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  if (refused) return <ErrorState message={`You are logged in as ${email ?? 'someone'}, who isn't one of FF's operators.`} />;
  if (failure) return <ErrorState message={failure} />;
  if (!page) return <Loading />;
  const fn = page.function;

  const view = async (reason: string) => {
    if (!look) return;
    try {
      if (look.kind === 'code') setShown({ kind: 'code', ...(await supportApi.code(id, reason)).data });
      else if (look.kind === 'call') setShown({ kind: 'call', data: (await supportApi.call(id, look.callId, reason)).data });
      else setShown({ kind: 'logs', callId: look.callId, lines: (await supportApi.logs(id, reason, look.callId ? { requestId: look.callId, sinceSeconds: 2_592_000 } : { sinceSeconds: 3600 })).data.lines });
      setLook(null);
    } catch (error) {
      throw new Error(apiErrorMessage(error));
    }
  };
  const callRows = (calls: Call[]) =>
    calls.map((call) => [
      <span className={`font-mono text-xs ${call.id === asked ? 'rounded bg-yellow-100 px-1' : ''}`}>{call.id}</span>,
      outcome(call),
      milliseconds(call.duration),
      whenUtc(call.createdAt),
      <span className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-secondary" onClick={() => setLook({ kind: 'call', callId: call.id })}>
          View data
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setLook({ kind: 'logs', callId: call.id })}>
          View logs
        </button>
      </span>,
    ]);
  const dialog = look && lookDialog(look, fn.name);

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <p className="text-sm text-gray-600">
          <Link to={`/accounts/${page.account.id}`} className="text-blue-700 hover:underline">
            {page.account.name}
          </Link>{' '}
          › function
        </p>
        <h1 className="text-2xl font-bold">{fn.name}</h1>
        <p className="font-mono text-sm text-gray-500">{fn.id}</p>
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">The function</h2>
        <dl className="card space-y-3">
          <Fact label="Account">
            <Link to={`/accounts/${page.account.id}`} className="text-blue-700 hover:underline">
              {page.account.name} ({page.account.id})
            </Link>{' '}
            <StatusBadge status={page.account.status} /> · owners: {ownersOf(page.account)}
          </Fact>
          <Fact label="Status">{fn.status}</Fact>
          {fn.error && <Fact label="Its last deploy failed">{fn.error}</Fact>}
          <Fact label="Runtime">{fn.runtime}</Fact>
          <Fact label="Memory, timeout">{`${fn.memory} MB, ${fn.timeout} s`}</Fact>
          <Fact label="Instances">{`${fn.minInstances} kept warm, ${fn.maxInstances} at most`}</Fact>
          <Fact label="Created, changed">{`${whenUtc(fn.createdAt)}, ${whenUtc(fn.updatedAt)}`}</Fact>
        </dl>
        <div className="flex flex-wrap gap-3">
          <button type="button" className="btn btn-secondary" onClick={() => setLook({ kind: 'code' })}>
            View code
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setLook({ kind: 'logs' })}>
            View the last hour's logs
          </button>
        </div>
        <p className="text-sm text-gray-600">
          The code, a call's data and the logs are the customer's: each look needs a reason, and the account's owners see it in their audit log.
        </p>
      </section>

      {shown && (
        <section className="space-y-3" aria-label="What you looked at">
          <h2 className="text-lg font-semibold">
            {shown.kind === 'code' ? `Its code (${shown.runtime})` : shown.kind === 'call' ? `Call ${shown.data.id}` : shown.callId ? `The log lines of call ${shown.callId}` : "The last hour's log lines"}
          </h2>
          {shown.kind === 'code' && <pre className="card max-h-[32rem] overflow-auto whitespace-pre-wrap break-all text-sm">{shown.code}</pre>}
          {shown.kind === 'call' && (
            <div className="card space-y-3">
              <p className="text-sm">{`${outcome(shown.data)} · ${milliseconds(shown.data.duration)} · ${whenUtc(shown.data.createdAt)}`}</p>
              <Value label="Input" value={shown.data.input} truncated={shown.data.inputTruncated} />
              <Value label="Output" value={shown.data.output} truncated={shown.data.outputTruncated} />
              {shown.data.error && (
                <div>
                  <h3 className="text-sm font-medium text-gray-700">Error</h3>
                  <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-red-50 p-2 text-sm text-red-800">{shown.data.error}</pre>
                  {shown.data.errorTruncated && <p className="mt-1 text-xs text-gray-500">{TRUNCATED}</p>}
                </div>
              )}
            </div>
          )}
          {shown.kind === 'logs' &&
            (shown.lines.length === 0 ? (
              <EmptyState>No line.</EmptyState>
            ) : (
              <div role="log" className="card max-h-[32rem] overflow-auto bg-gray-900 font-mono text-xs text-gray-100">
                {shown.lines.map((line, index) => (
                  <div key={index} className={`flex gap-3 ${line.stream === 'stderr' ? 'text-red-300' : ''}`}>
                    <span className="shrink-0 text-gray-400">{line.time.slice(11, 23)}</span>
                    <span className="whitespace-pre-wrap break-all">{line.message}</span>
                  </div>
                ))}
              </div>
            ))}
        </section>
      )}

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Recent failures</h2>
        {page.recentErrors.length === 0 ? (
          <EmptyState>No failure in the history.</EmptyState>
        ) : (
          <Table head={['Request ID', 'Outcome', 'Duration', 'At', '']} rows={callRows(page.recentErrors)} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Recent calls</h2>
        {asked && !page.recentCalls.some((call) => call.id === asked) && (
          <p className="text-sm">
            Call <span className="font-mono">{asked}</span> isn't among the newest.{' '}
            <button type="button" className="text-blue-700 underline" onClick={() => setLook({ kind: 'call', callId: asked })}>
              View its data
            </button>
          </p>
        )}
        {page.recentCalls.length === 0 ? (
          <EmptyState>No call in the history.</EmptyState>
        ) : (
          <Table head={['Request ID', 'Outcome', 'Duration', 'At', '']} rows={callRows(page.recentCalls)} />
        )}
      </section>

      {look && dialog && (
        <ReasonDialog title={dialog.title} confirmLabel={dialog.confirmLabel} busyLabel="Opening…" onConfirm={view} onCancel={() => setLook(null)}>
          <p>{dialog.body}</p>
        </ReasonDialog>
      )}
    </div>
  );
};

export default FunctionPage;
