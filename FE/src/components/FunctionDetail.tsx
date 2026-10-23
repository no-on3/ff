import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch } from 'react-redux';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Tabs, Tab } from '@mui/material';
import {
  EditableFields,
  FUNCTION_NAME_PATTERN,
  INVOCATION_STATUS_INFO,
  eventFormatText,
  FUNCTION_NAME_RULE,
  MAX_FUNCTION_NAME_LENGTH,
  TRUNCATED_NOTE,
  apiErrorMessage,
  changedFields,
  formatBytes,
  formatDuration,
  formatMemory,
  historyText,
  parseInvokeInput,
  sourceText,
} from '../lib/functions';
import { RUNTIME_LABELS, STATUS_INFO } from '../lib/function-list';
import { Function, FunctionInvocation, functionsApi } from '../services/api';
import { can } from '../lib/session';
import { useSession } from '../session/session';
import { updateFunction } from '../store/functionSlice';
import { AppDispatch } from '../store/store';
import { LogsFilter, filterFromSearch, searchForFilter } from '../lib/logs';
import { EnvironmentTab } from './FunctionEnvironment';
import { FunctionUrlTab } from './FunctionUrl';
import { FunctionSchedules } from './FunctionSchedules';
import { FunctionLogs } from './FunctionLogs';
import FunctionAlarms from './FunctionAlarms';
import Icon from './Icon';
import { MetricsDashboard } from './MetricsDashboard';
import { Page, PageHeader } from './Page';
import { Callout, Panel } from './Panel';
import { ScalingConfiguration } from './ScalingConfiguration';
import StatusPill from './StatusPill';

/** How many invocations the history shows, newest first. */
const HISTORY_PAGE = 20;

/** The page's tabs, by their name in the address (`?tab=logs`), so that a link opens one, in their order. */
const TABS = ['overview', 'environment', 'url', 'schedules', 'invocations', 'logs', 'metrics', 'scaling'] as const;
const TAB_LABELS: Record<(typeof TABS)[number], string> = {
  overview: 'Overview',
  environment: 'Environment',
  url: 'URL',
  schedules: 'Schedules',
  invocations: 'Invocations',
  logs: 'Logs',
  metrics: 'Metrics',
  scaling: 'Scaling',
};

/** A field's label above it, as every form of the page has them. */
const FieldLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => <span className="text-[13px] font-medium text-gray-700">{children}</span>;

/** An input, an output or an error the history kept: its JSON, or its start when it kept only that. */
const HistoryValue: React.FC<{ label: string; text: string; truncated: boolean; danger?: boolean }> = ({ label, text, truncated, danger }) => (
  <div className="min-w-0">
    <h3 className={`mb-1 text-xs font-medium ${danger ? 'text-red-700' : 'text-gray-600'}`}>{label}</h3>
    <pre
      className={`max-h-64 overflow-auto rounded-md border px-3 py-2 font-mono text-xs leading-5 break-all whitespace-pre-wrap ${
        danger ? 'border-red-100 bg-red-50 text-red-800' : 'border-line bg-gray-50 text-gray-800'
      }`}
    >
      {text}
    </pre>
    {truncated && <p className="mt-1 text-xs text-gray-500">{TRUNCATED_NOTE}</p>}
  </div>
);

const FunctionDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { plan, role } = useSession().account!; // the function pages show only for an account
  const mayChange = can(role, 'change functions');
  const dispatch = useDispatch<AppDispatch>();

  const [func, setFunc] = useState<Function | null>(null);
  const [form, setForm] = useState<EditableFields | null>(null);
  const [invocations, setInvocations] = useState<FunctionInvocation[]>([]);
  const [total, setTotal] = useState(0);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [invoking, setInvoking] = useState(false);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = Math.max(0, TABS.indexOf(searchParams.get('tab') as (typeof TABS)[number]));
  const tab = TABS[activeTab];
  const logsFilter = useMemo(() => filterFromSearch(searchParams), [searchParams]);
  const showLogs = (filter: LogsFilter) => setSearchParams(searchForFilter(filter));

  const loadHistory = useCallback(async () => {
    const page = (await functionsApi.getFunctionInvocations(id!, HISTORY_PAGE)).data;
    setInvocations(page.invocations);
    setTotal(page.total);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const load = async () => {
      try {
        setLoading(true);
        const { data } = await functionsApi.getFunction(id);
        setFunc(data);
        setForm({ name: data.name, code: data.code, memory: data.memory, timeout: data.timeout, eventFormat: data.eventFormat });
        await loadHistory();
      } catch (err) {
        setLoadError(apiErrorMessage(err));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [id, loadHistory]);

  // Calls come from elsewhere too (its URL, the API, a schedule): the history is read again each time its tab opens.
  useEffect(() => {
    if (tab !== 'invocations' || loading) return;
    void loadHistory().catch((err: unknown) => setInvokeError(apiErrorMessage(err)));
  }, [tab, loading, loadHistory]);

  const handleInvoke = async () => {
    const parsed = parseInvokeInput(input);
    if (!parsed.ok) {
      setInvokeError(parsed.error);
      return;
    }
    setInvoking(true);
    setInvokeError(null);
    try {
      const { data } = await functionsApi.invokeFunction(id!, parsed.input);
      setInvocations((previous) => [data, ...previous]);
      setTotal((count) => count + 1);
    } catch (err) {
      // A function's error answers 400 with its message; the failed invocation is in the history.
      setInvokeError(apiErrorMessage(err));
      await loadHistory().catch(() => undefined);
    } finally {
      setInvoking(false);
    }
  };

  const handleUpdate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!func || !form) return;
    const changes = changedFields(func, form);
    // An unchanged ACTIVE function needs nothing; one in ERROR is retried even unchanged.
    if (Object.keys(changes).length === 0 && func.status === 'ACTIVE') {
      navigate('/functions');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await dispatch(updateFunction({ id: func.id, data: changes })).unwrap();
      navigate('/functions');
    } catch (err) {
      setSaveError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setSearchParams(newValue === 0 ? {} : { tab: TABS[newValue] });
  };

  if (loading) {
    return (
      <Page>
        <p className="py-16 text-center text-gray-500">Loading…</p>
      </Page>
    );
  }

  if (loadError) {
    return (
      <Page>
        <Callout tone="danger" role="alert" title="This function can't be read">
          {loadError}
        </Callout>
      </Page>
    );
  }

  if (!func || !form) {
    return (
      <Page>
        <p className="py-16 text-center text-gray-600">Function not found</p>
      </Page>
    );
  }

  const status = STATUS_INFO[func.status];

  return (
    <Page>
      <PageHeader
        crumbs={[{ label: 'Functions', to: '/functions' }]}
        title={func.name}
        aside={<StatusPill tone={status.tone} label={status.label} title={func.error ?? undefined} />}
        description={
          <span className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            <span>{RUNTIME_LABELS[func.runtime]}</span>
            <span>
              Handler <code className="font-mono text-gray-800">{func.handler}</code>
            </span>
            <span>{func.memory} MB</span>
            <span>{func.timeout} s timeout</span>
            <span>{func.packageType === 'zip' ? `Package, ${formatBytes(func.codeSize)}` : 'Inline code'}</span>
          </span>
        }
      />

      {/* On a phone the tabs don't fit: the bar scrolls by touch. Scroll buttons would appear after the open tab is scrolled into view, and hide it. */}
      <Tabs value={activeTab} onChange={handleTabChange} variant="scrollable" scrollButtons={false} sx={{ mb: 3 }}>
        {TABS.map((name) => (
          <Tab key={name} label={TAB_LABELS[name]} />
        ))}
      </Tabs>

      {tab === 'overview' && (
        <div className="space-y-5">
          {func.eventFormat === 'wrapped' && (
            <Callout tone="warning" title={`This function gets ${eventFormatText(func)}.`}>
              It was made before functions got AWS Lambda&apos;s event, the input itself, which every new function gets, and which a web address or a
              schedule needs. To move it, change its handler to read <code>event</code> where it reads <code>event.body</code>, and choose AWS
              Lambda&apos;s event below, in the same update: the new version rolls out, and the previous one stays if it can&apos;t start.
            </Callout>
          )}

          {func.status === 'ERROR' && func.error && (
            <Callout tone="danger" role="alert" title="This function can't run:">
              <pre className="font-mono text-xs break-all whitespace-pre-wrap">{func.error}</pre>
              <p className="mt-2">Fix the code and update the function. An update without changes retries the same code.</p>
            </Callout>
          )}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Panel title="Configuration">
              <form onSubmit={handleUpdate}>
                <fieldset disabled={!mayChange} className="space-y-4">
                  <label className="block">
                    <FieldLabel>Name</FieldLabel>
                    <input
                      type="text"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      className="input mt-1"
                      maxLength={MAX_FUNCTION_NAME_LENGTH}
                      // Only a new name must follow the rule: one given before it keeps until it changes.
                      pattern={form.name !== func.name ? FUNCTION_NAME_PATTERN : undefined}
                      title={FUNCTION_NAME_RULE}
                    />
                  </label>

                  {func.packageType === 'zip' ? (
                    <Callout tone="neutral" title="This function runs a package, its libraries in it: its code isn't edited here.">
                      A new version is a new package: <code>ff deploy</code> with its folder, or <code>POST /packages</code> with its zip, then an update
                      naming its SHA-256 in <code>codeSha256</code>.
                    </Callout>
                  ) : (
                    <label className="block">
                      <FieldLabel>Code</FieldLabel>
                      <textarea
                        value={form.code}
                        onChange={(e) => setForm({ ...form, code: e.target.value })}
                        className="input mt-1 font-mono text-[13px] leading-5"
                        rows={14}
                        spellCheck={false}
                      />
                    </label>
                  )}

                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block">
                      <FieldLabel>Memory (MB)</FieldLabel>
                      <input
                        type="number"
                        min={128}
                        max={Math.max(plan.limits.memoryMb, func.memory)}
                        value={form.memory}
                        onChange={(e) => setForm({ ...form, memory: Number(e.target.value) })}
                        className="input mt-1"
                      />
                    </label>
                    <label className="block">
                      <FieldLabel>Timeout (s)</FieldLabel>
                      <input
                        type="number"
                        min={1}
                        max={Math.max(plan.limits.timeoutSeconds, func.timeout)}
                        value={form.timeout}
                        onChange={(e) => setForm({ ...form, timeout: Number(e.target.value) })}
                        className="input mt-1"
                      />
                    </label>
                  </div>
                  <p className="text-[13px] text-gray-500">
                    The {plan.name} plan allows up to {plan.limits.memoryMb} MB and {plan.limits.timeoutSeconds} s per function.
                  </p>
                  {func.eventFormat === 'wrapped' && (
                    <label className="block">
                      <FieldLabel>Event</FieldLabel>
                      <select
                        value={form.eventFormat}
                        onChange={(e) => setForm({ ...form, eventFormat: e.target.value as EditableFields['eventFormat'] })}
                        className="select mt-1 w-full"
                      >
                        <option value="wrapped">FF&apos;s original: the input in event.body</option>
                        <option value="lambda">AWS Lambda&apos;s: the input itself</option>
                      </select>
                    </label>
                  )}
                </fieldset>

                {saveError && (
                  <Callout tone="danger" role="alert" className="mt-4">
                    {saveError}
                  </Callout>
                )}

                <div className="mt-5 border-t border-line pt-4">
                  {mayChange ? (
                    <button type="submit" className="btn btn-primary" disabled={saving}>
                      {saving ? 'Updating… (waits until the new version is live)' : 'Update function'}
                    </button>
                  ) : (
                    <p className="text-[13px] text-gray-600">As a viewer, you read this function; owners and developers change it.</p>
                  )}
                </div>
              </form>
            </Panel>

            <div className="space-y-5">
              <Panel title="Code">
                <dl className="space-y-3 text-[13px]">
                  <div>
                    <dt className="text-gray-500">What runs</dt>
                    <dd className="text-gray-800">
                      {func.packageType === 'zip' ? 'A package' : 'Inline code'}, {formatBytes(func.codeSize)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">SHA-256</dt>
                    <dd className="font-mono text-xs break-all text-gray-800">{func.codeSha256}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Event</dt>
                    <dd className="text-gray-800">{eventFormatText(func)}</dd>
                  </div>
                  <div>
                    <dt className="text-gray-500">Last change</dt>
                    <dd className="text-gray-800">{new Date(func.updatedAt).toLocaleString()}</dd>
                  </div>
                </dl>
              </Panel>
              <FunctionAlarms functionId={func.id} mayChange={mayChange} />
            </div>
          </div>
        </div>
      )}

      {tab === 'environment' && <EnvironmentTab func={func} mayChange={mayChange} onSaved={setFunc} />}

      {tab === 'url' && <FunctionUrlTab func={func} mayChange={mayChange} />}

      {tab === 'schedules' && <FunctionSchedules func={func} mayChange={mayChange} />}

      {tab === 'invocations' && (
        <div className="space-y-5">
          <Panel title="Invoke">
            {mayChange ? (
              <div className="flex flex-col gap-3 sm:flex-row">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  aria-label="Event"
                  placeholder={
                    func.eventFormat === 'wrapped'
                      ? 'Any JSON value, which the handler gets as event.body, e.g. {"name": "Tunis"}; empty means {}'
                      : 'The event: any JSON value, e.g. {"name": "Tunis"}; empty means {}'
                  }
                  className="input min-h-[84px] flex-grow font-mono text-[13px]"
                  rows={3}
                  spellCheck={false}
                />
                <button type="button" onClick={handleInvoke} disabled={invoking} className="btn btn-primary self-start">
                  {invoking ? 'Invoking…' : 'Invoke'}
                </button>
              </div>
            ) : (
              <p className="text-[13px] text-gray-600">As a viewer, you read the history; owners and developers invoke.</p>
            )}
            {invokeError && (
              <Callout tone="danger" role="alert" className="mt-4">
                {invokeError}
              </Callout>
            )}
          </Panel>

          <Panel
            flush
            title="History"
            description={
              <>
                Each call is kept for your plan&apos;s history retention (<Link to="/account">Account</Link>), with up to 64 KiB of its input, output and
                error.
              </>
            }
            actions={
              total > invocations.length && (
                <span className="text-xs text-gray-500">
                  The latest {invocations.length} of {total.toLocaleString('en-US')}
                </span>
              )
            }
          >
            {invocations.length === 0 ? (
              <p className="px-5 py-10 text-center text-gray-500">No invocations in the history yet.{mayChange && ' Invoke the function above.'}</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {invocations.map((invocation) => {
                  const info = INVOCATION_STATUS_INFO[invocation.status];
                  return (
                    <li key={invocation.id}>
                      <details className="group">
                        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 hover:bg-gray-50/70 [&::-webkit-details-marker]:hidden">
                          <Icon name="chevron" className="-rotate-90 text-gray-400 transition-transform group-open:rotate-0" />
                          <StatusPill tone={info.tone} label={info.label} title={info.note} />
                          <span className="text-gray-800 tabular-nums">{new Date(invocation.createdAt).toLocaleString()}</span>
                          <span className="text-gray-500">{sourceText(invocation.source)}</span>
                          <span className="ml-auto flex gap-4 text-[13px] text-gray-600 tabular-nums">
                            <span title="Duration">{formatDuration(invocation.duration)}</span>
                            <span title="Most memory used">{formatMemory(invocation.memoryUsed)}</span>
                          </span>
                        </summary>
                        <div className="space-y-3 px-5 pb-4 sm:pl-12">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500">
                            <span>
                              Request <code className="font-mono text-gray-700">{invocation.id}</code>
                            </span>
                            <span>Ended {new Date(invocation.updatedAt).toLocaleTimeString()}</span>
                            <Link to={`?${searchForFilter({ range: 'all', q: '', requestId: invocation.id }).toString()}`}>Its logs</Link>
                          </div>
                          <div className="grid gap-3 lg:grid-cols-2">
                            <HistoryValue label="Input" text={historyText(invocation.input, invocation.inputTruncated)} truncated={invocation.inputTruncated} />
                            <HistoryValue label="Output" text={historyText(invocation.output, invocation.outputTruncated)} truncated={invocation.outputTruncated} />
                          </div>
                          {invocation.error && <HistoryValue danger label="Error" text={invocation.error} truncated={invocation.errorTruncated} />}
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      )}

      {tab === 'logs' && <FunctionLogs functionId={id!} filter={logsFilter} onFilterChange={showLogs} />}

      {tab === 'metrics' && <MetricsDashboard functionId={id!} />}

      {tab === 'scaling' && <ScalingConfiguration functionId={id!} />}
    </Page>
  );
};

export default FunctionDetail;
