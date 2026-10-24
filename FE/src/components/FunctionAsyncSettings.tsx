import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { AsyncSettingsForm, KEPT_MINUTES, asyncCallsText, asyncSettingsBody, asyncSettingsForm, asyncSettingsText, destinationText } from '../lib/async-settings';
import { apiErrorMessage } from '../lib/functions';
import { EventInvokeConfig, Function, eventInvokeConfigApi, functionsApi, metricsApi, queuesApi } from '../services/api';
import { Callout, Panel } from './Panel';

/**
 * A function's settings for its calls that don't wait, as AWS Lambda's
 * asynchronous invocation configuration: how many times a call that fails is
 * retried, how long it is kept, and another function or a queue of the
 * account that gets each call's record once it succeeds, or fails for good.
 * Every member reads them; owners and developers change them, or go back to
 * Lambda's defaults. Below them, its calls of the last day, as Lambda's
 * metrics count them.
 */
export const FunctionAsyncSettings: React.FC<{ func: Function; mayChange: boolean }> = ({ func, mayChange }) => {
  /** undefined while loading; null when the function has none, and follows Lambda's defaults. */
  const [config, setConfig] = useState<EventInvokeConfig | null | undefined>(undefined);
  const [form, setForm] = useState<AsyncSettingsForm>(asyncSettingsForm(null));
  const [others, setOthers] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastDay, setLastDay] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    metricsApi
      .forFunction(func.id, { period: 3600, start: new Date(Date.now() - 23 * 3_600_000).toISOString() })
      .then(({ data }) => current && setLastDay(asyncCallsText(data)))
      .catch(() => current && setLastDay(null));
    eventInvokeConfigApi
      .get(func.id)
      .then(({ data }) => current && setConfig(data))
      .catch((err: unknown) => {
        if (!current) return;
        if (axios.isAxiosError(err) && err.response?.status === 404) setConfig(null);
        else setError(apiErrorMessage(err));
      });
    return () => {
      current = false;
    };
  }, [func.id]);

  const edit = async () => {
    setForm(asyncSettingsForm(config ?? null));
    setError(null);
    setEditing(true);
    try {
      // The account's other functions by name, and its queues by ARN, as the API takes each.
      const [functions, queues] = await Promise.all([functionsApi.getAllFunctions(), queuesApi.list().then((answer) => answer.data, () => [])]);
      setOthers([
        ...functions.data.filter((other) => other.id !== func.id).map((other) => other.name).sort(),
        ...queues.map((queue) => queue.arn).sort(),
      ]);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const built = asyncSettingsBody(form);
    if ('problem' in built) {
      setError(built.problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await eventInvokeConfigApi.put(func.id, built.body);
      setConfig(data);
      setEditing(false);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      await eventInvokeConfigApi.remove(func.id);
      setConfig(null);
      setEditing(false);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const destination = (field: 'onSuccess' | 'onFailure', label: string) => (
    <label className="flex flex-col gap-1 text-[13px] text-gray-700">
      {label}
      <select className="input" value={form[field]} onChange={(e) => setForm({ ...form, [field]: e.target.value })}>
        <option value="">Nowhere</option>
        {[...new Set([...others, form[field]].filter(Boolean))].map((name) => (
          <option key={name} value={name}>
            {destinationText(name)}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <Panel
      title="Calls that don't wait"
      description="How this function's asynchronous calls are retried and kept, and where each one's record goes once it ends, as AWS Lambda's asynchronous invocation settings."
      actions={
        mayChange && config !== undefined && !editing ? (
          <button type="button" className="btn btn-secondary" onClick={() => void edit()}>
            Change
          </button>
        ) : undefined
      }
    >
      {error && (
        <Callout tone="danger" role="alert" className="mb-4">
          {error}
        </Callout>
      )}
      {config === undefined && !error && <p className="text-[13px] text-gray-500">Loading…</p>}
      {config !== undefined && !editing && <p className="text-[13px] text-gray-700">{asyncSettingsText(config)}</p>}
      {lastDay && !editing && <p className="mt-2 text-[13px] text-gray-600">In the last day: {lastDay}</p>}
      {editing && (
        <form onSubmit={(event) => void save(event)} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[13px] text-gray-700">
              Retries after a failure
              <select className="input" value={form.retries} onChange={(e) => setForm({ ...form, retries: Number(e.target.value) })}>
                <option value={0}>None</option>
                <option value={1}>Once</option>
                <option value={2}>Twice, a minute then two minutes later</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-gray-700">
              Kept at most, in minutes
              <input
                className="input"
                type="number"
                min={KEPT_MINUTES.min}
                max={KEPT_MINUTES.max}
                step={1}
                value={form.keptMinutes}
                onChange={(e) => setForm({ ...form, keptMinutes: e.target.value })}
              />
            </label>
            {destination('onSuccess', 'Once a call succeeds, its record goes to')}
            {destination('onFailure', 'Once its retries are used up, or it is too old, to')}
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
            {config && (
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void reset()}>
                Back to Lambda's defaults
              </button>
            )}
          </div>
        </form>
      )}
    </Panel>
  );
};
