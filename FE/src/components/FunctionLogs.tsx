import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EventStreamParser, LogsFilter, TIME_RANGES, TimeRange, lineTime, logsErrorMessage, mergeLines, pageQuery } from '../lib/logs';
import { FunctionLogLine, logsApi } from '../services/api';

interface Props {
  functionId: string;
  filter: LogsFilter;
  onFilterChange: (filter: LogsFilter) => void;
}

const STREAM_STYLES: Record<string, string> = { stderr: 'text-red-300', ff: 'text-amber-300' };

/**
 * A function's logs (P-44): a page of the newest lines of a time range, narrowed
 * to a phrase or a call, older pages on demand, and the live tail, which adds
 * new lines as they come, about 5 s after they were written.
 */
export const FunctionLogs: React.FC<Props> = ({ functionId, filter, onFilterChange }) => {
  const { range, q, requestId } = filter;
  const [lines, setLines] = useState<FunctionLogLine[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phrase, setPhrase] = useState(q);
  const [live, setLive] = useState(false);
  const [liveNote, setLiveNote] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const followBottom = useRef(true);

  useEffect(() => setPhrase(q), [q]);

  // A page of the filter's newest lines, whenever the filter changes.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    logsApi
      .page(functionId, pageQuery({ range, q, requestId }))
      .then(({ data }) => {
        if (cancelled) return;
        setLines(data.lines);
        setNext(data.next);
        followBottom.current = true;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLines([]);
        setNext(null);
        setError(logsErrorMessage(err));
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [functionId, range, q, requestId, reloads]);

  // The live tail, while it is on: opened again when it ends after its 30 minutes.
  useEffect(() => {
    if (!live) return;
    const abort = new AbortController();
    void (async () => {
      setLiveNote('Following: new lines come about 5 seconds after they are written.');
      for (;;) {
        const parser = new EventStreamParser();
        let ended = false;
        let unavailable: string | null = null;
        try {
          await logsApi.stream(functionId, { q: q.trim() || undefined, requestId: requestId || undefined }, abort.signal, (text) => {
            const incoming: FunctionLogLine[] = [];
            for (const event of parser.push(text)) {
              if (event.type === 'message') incoming.push(JSON.parse(event.data) as FunctionLogLine);
              else if (event.type === 'end') ended = true;
              else if (event.type === 'unavailable') unavailable = (JSON.parse(event.data) as { message: string }).message;
            }
            if (incoming.length > 0) setLines((current) => mergeLines(current, incoming));
          });
        } catch (err) {
          if (abort.signal.aborted) return;
          unavailable = logsErrorMessage(err);
        }
        if (abort.signal.aborted) return;
        if (!ended) {
          setLiveNote(`The live tail stopped: ${unavailable ?? 'the connection closed'}.`);
          setLive(false);
          return;
        }
      }
    })();
    return () => abort.abort();
  }, [live, functionId, q, requestId]);

  // New lines at the bottom stay in view, unless the reader scrolled up.
  useLayoutEffect(() => {
    const element = list.current;
    if (element && followBottom.current) element.scrollTop = element.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const element = list.current;
    if (element) followBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
  };

  const loadOlder = useCallback(async () => {
    if (!next) return;
    setLoadingOlder(true);
    try {
      const { data } = await logsApi.page(functionId, pageQuery({ range, q, requestId }, next));
      followBottom.current = false;
      setLines((current) => [...data.lines, ...current]);
      setNext(data.next);
    } catch (err) {
      setError(logsErrorMessage(err));
    } finally {
      setLoadingOlder(false);
    }
  }, [functionId, next, range, q, requestId]);

  return (
    <div>
      <form
        className="flex flex-wrap items-end gap-3 mb-3"
        onSubmit={(event) => {
          event.preventDefault();
          onFilterChange({ ...filter, q: phrase });
        }}
      >
        <label className="text-sm text-gray-700">
          Time range
          <select className="input mt-1 block" value={range} onChange={(e) => onFilterChange({ ...filter, range: e.target.value as TimeRange })}>
            {TIME_RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm text-gray-700 grow">
          Phrase
          <input
            className="input mt-1 block w-full"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            placeholder="Whole words, with their case: time out"
            maxLength={500}
          />
        </label>
        <button type="submit" className="btn btn-primary">
          Search
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => setReloads((n) => n + 1)} disabled={loading}>
          Refresh
        </button>
        <label className="flex items-center gap-2 text-sm text-gray-700 pb-2">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Live
        </label>
      </form>

      {requestId && (
        <p className="text-sm text-gray-700 mb-2">
          Only the lines of call <code>{requestId}</code>.{' '}
          <button type="button" className="text-blue-600 underline" onClick={() => onFilterChange({ ...filter, requestId: '' })}>
            Show every call's
          </button>
        </p>
      )}
      {liveNote && <p className="text-sm text-gray-600 mb-2">{liveNote}</p>}
      {error && <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-3">{error}</div>}

      <div ref={list} onScroll={onScroll} role="log" aria-label="Log lines" className="bg-gray-900 text-gray-100 font-mono text-xs rounded p-3 max-h-[32rem] overflow-y-auto">
        {next && (
          <button type="button" className="text-blue-300 underline mb-2" onClick={() => void loadOlder()} disabled={loadingOlder}>
            {loadingOlder ? 'Loading…' : 'Load older lines'}
          </button>
        )}
        {lines.map((line, index) => (
          <div key={`${index}:${line.time}`} className={`flex items-start gap-3 ${STREAM_STYLES[line.stream ?? ''] ?? ''}`}>
            <span className="text-gray-400 shrink-0" title={line.time}>
              {lineTime(line.time)}
            </span>
            {line.requestId ? (
              <button
                type="button"
                className="text-blue-300 shrink-0 w-[8ch] text-left"
                title={`Only the lines of call ${line.requestId}`}
                onClick={() => onFilterChange({ ...filter, requestId: line.requestId! })}
              >
                {line.requestId.slice(0, 8)}
              </button>
            ) : (
              <span className="shrink-0 w-[8ch]" />
            )}
            <span className="whitespace-pre-wrap break-all" title={line.instance ?? 'FF'}>
              {line.message}
            </span>
          </div>
        ))}
        {loading && lines.length === 0 && <p className="text-gray-400">Loading…</p>}
        {!loading && !error && lines.length === 0 && (
          <p className="text-gray-400">No lines in this time range{q.trim() ? ' with this phrase' : ''}{requestId ? ' for this call' : ''}.</p>
        )}
      </div>
      <p className="text-xs text-gray-500 mt-2">
        Red lines are stderr. An amber line is FF&apos;s: the account wrote more than its limit in that second, and it says how many lines were dropped.
      </p>
    </div>
  );
};
