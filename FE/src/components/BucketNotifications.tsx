import React, { useCallback, useEffect, useState } from 'react';
import { EVENT_WORDS, FORM_EVENTS, NotificationEntry, NotificationForm, configurationBody, emptyNotificationForm, entriesOf, entryOf, notificationText } from '../lib/bucket-notifications';
import { apiErrorMessage } from '../lib/functions';
import { bucketsApi, functionsApi, queuesApi } from '../services/api';
import { Callout, Panel } from './Panel';

/**
 * A bucket's notifications, as S3's: each configuration's events, the keys it
 * names, and the function it runs without waiting or the queue it sends to.
 * Every member reads them; owners and developers add one, the account's
 * functions and queues offered, or remove one. The API keeps the list whole,
 * as S3 does: the panel puts it back with each change.
 */
export const BucketNotifications: React.FC<{ bucketName: string; mayChange: boolean }> = ({ bucketName, mayChange }) => {
  const [entries, setEntries] = useState<NotificationEntry[] | undefined>(undefined);
  const [destinations, setDestinations] = useState<{ functions: string[]; queues: string[] }>({ functions: [], queues: [] });
  const [form, setForm] = useState<NotificationForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(entriesOf((await bucketsApi.notifications(bucketName)).data));
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [bucketName]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = async () => {
    setForm(emptyNotificationForm());
    setError(null);
    try {
      const [functions, queues] = await Promise.all([functionsApi.getAllFunctions(), queuesApi.list()]);
      setDestinations({ functions: functions.data.map((fn) => fn.name).sort(), queues: queues.data.map((queue) => queue.name).sort() });
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  };

  /** The list put back whole; the API's answer, S3's refusal in its words. */
  const keep = async (next: NotificationEntry[]) => {
    setBusy(true);
    setError(null);
    try {
      setEntries(entriesOf((await bucketsApi.setNotifications(bucketName, configurationBody(next))).data));
      setForm(null);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    if (!form || !entries) return;
    const made = entryOf(form);
    if ('problem' in made) return setError(made.problem);
    void keep([...entries, made.entry]);
  };

  const toggle = (type: string) =>
    form && setForm({ ...form, events: form.events.includes(type) ? form.events.filter((event) => event !== type) : [...form.events, type] });

  return (
    <Panel
      title="Notifications"
      description="Events of its objects, as S3 sends them: an upload or a deletion runs a function of the account without waiting, S3's event its input, or goes to a queue as a message."
      actions={
        mayChange && entries !== undefined && form === null ? (
          <button type="button" className="btn btn-secondary" onClick={() => void open()}>
            Add one
          </button>
        ) : undefined
      }
    >
      {error && (
        <Callout tone="danger" role="alert" className="mb-4">
          {error}
        </Callout>
      )}
      {entries === undefined && !error && <p className="text-[13px] text-gray-500">Loading…</p>}
      {entries?.length === 0 && form === null && <p className="text-[13px] text-gray-600">It sends no event.</p>}
      {entries && entries.length > 0 && (
        <ul className="mb-2 divide-y divide-gray-100" aria-label="Its notifications">
          {entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
              <span className="min-w-0 flex-1 text-[13px] text-gray-700">{notificationText(entry)}</span>
              <span className="break-all font-mono text-xs text-gray-500">{entry.id}</span>
              {mayChange && form === null && (
                <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void keep(entries.filter((other) => other.id !== entry.id))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {form && (
        <form onSubmit={add} className="space-y-4" aria-label="A new notification">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[13px] text-gray-700">
              Its events go to
              <select className="input" value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })}>
                <option value="">Choose one</option>
                <optgroup label="A function, called without waiting">
                  {destinations.functions.map((name) => (
                    <option key={`function:${name}`} value={`function:${name}`}>
                      {name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="A queue, as messages">
                  {destinations.queues.map((name) => (
                    <option key={`queue:${name}`} value={`queue:${name}`}>
                      {name}
                    </option>
                  ))}
                </optgroup>
              </select>
            </label>
            <fieldset className="flex flex-col gap-1 text-[13px] text-gray-700">
              <legend className="mb-1">For</legend>
              {FORM_EVENTS.map((type) => (
                <label key={type} className="flex items-center gap-2">
                  <input type="checkbox" checked={form.events.includes(type)} onChange={() => toggle(type)} />
                  {EVENT_WORDS[type]} <span className="font-mono text-xs text-gray-500">{type}</span>
                </label>
              ))}
            </fieldset>
            <label className="flex flex-col gap-1 text-[13px] text-gray-700">
              Keys beginning with
              <input className="input font-mono" value={form.prefix} placeholder="images/" onChange={(e) => setForm({ ...form, prefix: e.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-[13px] text-gray-700">
              Keys ending with
              <input className="input font-mono" value={form.suffix} placeholder=".jpg" onChange={(e) => setForm({ ...form, suffix: e.target.value })} />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Add'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                setForm(null);
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
