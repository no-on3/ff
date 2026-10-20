import React, { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { formatWhen } from '../lib/accounts';
import {
  AlarmForm,
  BILLING_METRICS,
  COMPARISONS,
  MAX_EVALUATION_PERIODS,
  MISSING_DATA,
  Metric,
  PERIODS,
  STATE_INFO,
  STATISTICS,
  UNITS,
  conditionText,
  emptyForm,
  formFromAlarm,
  formProblem,
  metricsFor,
  toBody,
  withMetric,
} from '../lib/alarms';
import { apiErrorMessage } from '../lib/functions';
import { can } from '../lib/session';
import { Alarm, AlarmState, Function, alarmsApi, functionsApi } from '../services/api';
import { useSession } from '../session/session';

const TONE = { ok: 'bg-green-100 text-green-800', alarm: 'bg-red-100 text-red-800', unknown: 'bg-gray-200 text-gray-700' } as const;
/** How often the list is read again: alarms are judged every minute. */
const REFRESH_MS = 20_000;

export const StateBadge: React.FC<{ state: AlarmState }> = ({ state }) => (
  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${TONE[STATE_INFO[state].tone]}`}>{STATE_INFO[state].label}</span>
);

const Field: React.FC<{ id: string; label: string; hint?: string; children: React.ReactNode }> = ({ id, label, hint, children }) => (
  <div>
    <label htmlFor={id} className="block text-sm font-medium text-gray-700 mb-1">
      {label}
    </label>
    {children}
    {hint && <p className="mt-1 text-xs text-gray-500">{hint}</p>}
  </div>
);

/** The form that creates an alarm, or replaces one. */
const AlarmEditor: React.FC<{ editing: Alarm | null; initial: AlarmForm; functions: Function[]; onDone(saved: boolean): void }> = ({ editing, initial, functions, onDone }) => {
  const [form, setForm] = useState<AlarmForm>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = formProblem(form);
  const billing = BILLING_METRICS.includes(form.metric);
  const set = (change: Partial<AlarmForm>) => setForm({ ...form, ...change });

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (problem) return;
    setSaving(true);
    setError(null);
    try {
      if (editing) await alarmsApi.update(editing.id, toBody(form));
      else await alarmsApi.create(toBody(form));
      onDone(true);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={save} className="card mb-6 space-y-4" aria-label={editing ? `Change ${editing.name}` : 'New alarm'}>
      <h2 className="text-lg font-semibold">{editing ? `Change "${editing.name}"` : 'New alarm'}</h2>
      <div className="grid gap-4 md:grid-cols-2">
        <Field id="alarm-name" label="Name">
          <input id="alarm-name" className="input" maxLength={100} value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field id="alarm-scope" label="Watches" hint={billing ? "The account's money is the account's." : undefined}>
          <select
            id="alarm-scope"
            className="input"
            value={form.functionId}
            disabled={billing}
            onChange={(e) => setForm(withMetric({ ...form, functionId: e.target.value }, metricsFor(e.target.value).includes(form.metric) ? form.metric : 'Errors'))}
          >
            <option value="">The whole account</option>
            {functions.map((fn) => (
              <option key={fn.id} value={fn.id}>
                The function {fn.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="alarm-metric" label="Metric">
          <select id="alarm-metric" className="input" value={form.metric} onChange={(e) => setForm(withMetric(form, e.target.value as Metric))}>
            {metricsFor(form.functionId).map((metric) => (
              <option key={metric} value={metric}>
                {metric}
              </option>
            ))}
          </select>
        </Field>
        <Field id="alarm-statistic" label="Statistic">
          <select id="alarm-statistic" className="input" value={form.statistic} onChange={(e) => set({ statistic: e.target.value })}>
            {STATISTICS[form.metric].map((statistic) => (
              <option key={statistic} value={statistic}>
                {statistic}
              </option>
            ))}
          </select>
        </Field>
        <Field id="alarm-comparison" label="When it is">
          <div className="flex gap-2">
            <select id="alarm-comparison" className="input w-auto" value={form.comparison} onChange={(e) => set({ comparison: e.target.value as AlarmForm['comparison'] })}>
              {COMPARISONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.symbol}
                </option>
              ))}
            </select>
            <input id="alarm-threshold" aria-label="Threshold" className="input" inputMode="decimal" value={form.threshold} onChange={(e) => set({ threshold: e.target.value })} />
            <span className="self-center text-sm text-gray-600">{UNITS[form.metric]}</span>
          </div>
        </Field>
        {!billing && (
          <>
            <Field id="alarm-period" label="Period">
              <select id="alarm-period" className="input" value={form.period} onChange={(e) => set({ period: Number(e.target.value) })}>
                {PERIODS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field id="alarm-m" label="In" hint={`Of the last periods, how many must breach: up to ${MAX_EVALUATION_PERIODS} periods, a day at most`}>
              <div className="flex items-center gap-2">
                <input id="alarm-m" aria-label="Periods breaching" className="input w-20" inputMode="numeric" value={form.datapointsToAlarm} onChange={(e) => set({ datapointsToAlarm: e.target.value })} />
                <span className="text-sm text-gray-600">of the last</span>
                <input aria-label="Periods judged" className="input w-20" inputMode="numeric" value={form.evaluationPeriods} onChange={(e) => set({ evaluationPeriods: e.target.value })} />
                <span className="text-sm text-gray-600">periods</span>
              </div>
            </Field>
            <Field id="alarm-missing" label="A period without data" hint={MISSING_DATA.find((m) => m.value === form.treatMissingData)?.help}>
              <select id="alarm-missing" className="input" value={form.treatMissingData} onChange={(e) => set({ treatMissingData: e.target.value as AlarmForm['treatMissingData'] })}>
                {MISSING_DATA.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-gray-700">When it goes into alarm, and out of it, tell</legend>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={form.email} onChange={(e) => set({ email: e.target.checked })} />
          The account's owners, by e-mail
        </label>
        <Field id="alarm-webhooks" label="Webhook URLs, one per line" hint="Signed with the account's secret: see Notifications">
          <textarea id="alarm-webhooks" className="input font-mono text-sm" rows={2} value={form.webhookUrls} onChange={(e) => set({ webhookUrls: e.target.value })} />
        </Field>
      </fieldset>
      {problem && (
        <p className="text-sm text-amber-900" role="status">
          {problem}
        </p>
      )}
      {error && (
        <div role="alert" className="text-red-600">
          {error}
        </div>
      )}
      <div className="flex gap-3">
        <button type="submit" className="btn btn-primary" disabled={saving || !!problem}>
          {saving ? 'Saving…' : editing ? 'Save' : 'Create alarm'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
};

/**
 * The account's alarms: each with its state, what it watches, why it is in
 * its state and since when. Owners and developers of an active account create,
 * change and delete them.
 */
const Alarms: React.FC = () => {
  const { account } = useSession();
  const [params, setParams] = useSearchParams();
  const [alarms, setAlarms] = useState<Alarm[] | null>(null);
  const [functions, setFunctions] = useState<Function[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ alarm: Alarm | null; form: AlarmForm } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setAlarms((await alarmsApi.list()).data);
      setError(null);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  }, []);

  useEffect(() => {
    void load();
    functionsApi
      .getAllFunctions()
      .then(({ data }) => setFunctions(data))
      .catch(() => setFunctions([]));
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load, account?.id]);

  // A function's page links here to make an alarm on it.
  const forFunction = params.get('function');
  useEffect(() => {
    if (forFunction) setEditing({ alarm: null, form: emptyForm(forFunction) });
  }, [forFunction]);

  if (!account) return null;
  const writer = account.status === 'active' && can(account.role, 'change functions');
  const nameOf = (id: string | null) => (id ? (functions.find((fn) => fn.id === id)?.name ?? 'a function') : null);

  const done = async (saved: boolean) => {
    setEditing(null);
    if (forFunction) setParams({});
    if (saved) await load();
  };
  const remove = async (id: string) => {
    try {
      await alarmsApi.remove(id);
      setDeleting(null);
      await load();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Alarms</h1>
        {writer && !editing && (
          <button type="button" className="btn btn-primary" onClick={() => setEditing({ alarm: null, form: emptyForm() })}>
            New alarm
          </button>
        )}
      </div>
      <p className="mb-6 text-gray-600">
        Each alarm watches a metric of a function or of the account, or its money, and is judged every minute. Going into alarm, and out of it, it tells the
        account's owners and its webhooks.
      </p>
      {editing && <AlarmEditor key={editing.alarm?.id ?? 'new'} editing={editing.alarm} initial={editing.form} functions={functions} onDone={done} />}
      {error && (
        <div role="alert" className="mb-4 text-red-600">
          {error}
        </div>
      )}
      {alarms === null && !error && <p className="text-gray-500">Loading…</p>}
      {alarms?.length === 0 && <p className="card text-gray-600">No alarm yet.</p>}
      <ul className="space-y-3" aria-label="Alarms">
        {alarms?.map((alarm) => {
          const on = nameOf(alarm.functionId);
          return (
            <li key={alarm.id} data-alarm={alarm.id} className="card">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <StateBadge state={alarm.state} /> <span className="font-semibold">{alarm.name}</span>{' '}
                <span className="text-sm text-gray-600">
                  {on ? (
                    <>
                      on <Link to={`/functions/${alarm.functionId}`}>{on}</Link>
                    </>
                  ) : (
                    'on the account'
                  )}
                </span>
              </div>
              <p className="mt-2 text-sm text-gray-800">{conditionText(alarm)}</p>
              {alarm.stateReason && (
                <p className="mt-1 text-sm text-gray-600">
                  {alarm.stateReason}
                  {alarm.stateChangedAt && <> · since {formatWhen(alarm.stateChangedAt)}</>}
                </p>
              )}
              <p className="mt-1 text-xs text-gray-500">
                Tells {[alarm.actions.email ? "the owners' e-mail" : null, alarm.actions.webhookUrls.length ? `${alarm.actions.webhookUrls.length} webhook(s)` : null].filter(Boolean).join(' and ') || 'nobody'}
              </p>
              {writer && (
                <div className="mt-3 flex flex-wrap gap-3">
                  <button type="button" className="btn btn-secondary" onClick={() => setEditing({ alarm, form: formFromAlarm(alarm) })}>
                    Change
                  </button>
                  {deleting === alarm.id ? (
                    <span role="alertdialog" aria-label={`Delete ${alarm.name}`} className="flex flex-wrap items-center gap-2">
                      <span className="text-sm text-gray-700">Delete this alarm?</span>
                      <button type="button" className="btn btn-primary" onClick={() => void remove(alarm.id)}>
                        Delete
                      </button>
                      <button type="button" className="btn btn-secondary" onClick={() => setDeleting(null)}>
                        Keep it
                      </button>
                    </span>
                  ) : (
                    <button type="button" className="btn btn-secondary" onClick={() => setDeleting(alarm.id)}>
                      Delete…
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

export default Alarms;
