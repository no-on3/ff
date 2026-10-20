import React, { useCallback, useEffect, useState } from 'react';
import { formatWhen } from '../lib/accounts';
import { apiErrorMessage } from '../lib/functions';
import { anyPending, channelLabel, deliveryOutcome, Outcome, testUrlProblem } from '../lib/notifications';
import { can } from '../lib/session';
import { Delivery, WebhookSecret, notificationsApi } from '../services/api';
import { useSession } from '../session/session';

const TONE: Record<Outcome['tone'], string> = {
  ok: 'bg-green-100 text-green-800',
  waiting: 'bg-amber-100 text-amber-900',
  failed: 'bg-red-100 text-red-800',
};
/** How often the list is read again while a delivery is still to be sent. */
const REFRESH_MS = 5_000;

/** The signing secret: hidden until shown, copied, and rotated after a confirmation. The owners' only. */
const SigningSecret: React.FC<{ active: boolean }> = ({ active }) => {
  const [secret, setSecret] = useState<WebhookSecret | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (call: () => Promise<{ data: WebhookSecret }>) => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setSecret((await call()).data);
      setConfirming(false);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret?.secret ?? '');
      setCopied(true);
    } catch {
      setCopied(false); // the browser refused: the secret stays selectable
    }
  };

  return (
    <section className="card mb-6" aria-labelledby="signing-secret">
      <h2 id="signing-secret" className="text-lg font-semibold mb-1">
        Signing secret
      </h2>
      <p className="mb-4 text-sm text-gray-600">
        Every webhook carries <code>FF-Signature: t=…,v1=…</code>: the HMAC-SHA256 of <code>&lt;t&gt;.&lt;body&gt;</code>, keyed with this secret. Check it, and that{' '}
        <code>t</code> is recent, before trusting a webhook.
      </p>
      {secret ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <code data-testid="webhook-secret" className="select-all break-all rounded bg-gray-100 px-3 py-2 font-mono text-sm">
              {secret.secret}
            </code>
            <button type="button" className="btn btn-secondary" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="text-sm text-gray-600">
            Made {formatWhen(secret.createdAt)}.
            {secret.previousExpiresAt && ` The previous secret signs too until ${formatWhen(secret.previousExpiresAt)}, while your receivers change over.`}
          </p>
        </div>
      ) : (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(notificationsApi.secret)}>
          Show the secret
        </button>
      )}
      {active && !confirming && (
        <button type="button" className="btn btn-secondary mt-4 block" disabled={busy} onClick={() => setConfirming(true)}>
          Rotate the secret…
        </button>
      )}
      {confirming && (
        <div role="alertdialog" aria-labelledby="rotate-title" className="mt-4 rounded border border-amber-300 bg-amber-50 p-4">
          <p id="rotate-title" className="mb-3 text-amber-900">
            A new secret signs every webhook from now on. For 24 hours each one carries a signature by the old secret too: change your receivers to the new one within that day.
          </p>
          <div className="flex gap-3">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(notificationsApi.rotate)}>
              {busy ? 'Rotating…' : 'Rotate'}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && (
        <div role="alert" className="mt-3 text-red-600">
          {error}
        </div>
      )}
    </section>
  );
};

/** A test notification to a webhook URL, the owners' e-mail, or both. Owners and developers, in an active account. */
const SendTest: React.FC<{ onSent(): void }> = ({ onSent }) => {
  const [url, setUrl] = useState('');
  const [email, setEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = testUrlProblem(url);

  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setSent(false);
    setError(null);
    try {
      await notificationsApi.test({ ...(url.trim() ? { webhookUrl: url.trim() } : {}), ...(email ? { email: true } : {}) });
      setSent(true);
      onSent();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={send} className="card mb-6 space-y-3" aria-labelledby="send-test">
      <h2 id="send-test" className="text-lg font-semibold">
        Send a test
      </h2>
      <p className="text-sm text-gray-600">Sent as your alarms' notifications will be: each webhook signed, each owner's e-mail in their language.</p>
      <div>
        <label htmlFor="test-url" className="block text-sm font-medium text-gray-700 mb-1">
          Webhook URL
        </label>
        <input
          id="test-url"
          type="url"
          className="input"
          placeholder="https://example.tn/ff-hooks"
          maxLength={2048}
          value={url}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? 'test-url-problem' : undefined}
          onChange={(event) => setUrl(event.target.value)}
        />
        {problem && (
          <p id="test-url-problem" className="mt-1 text-sm text-red-600">
            {problem}
          </p>
        )}
      </div>
      <label className="flex items-center gap-2 text-sm text-gray-700">
        <input type="checkbox" checked={email} onChange={(event) => setEmail(event.target.checked)} />
        Also e-mail the account's owners
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" className="btn btn-primary" disabled={busy || !!problem || (!url.trim() && !email)}>
          {busy ? 'Sending…' : 'Send test'}
        </button>
        {sent && <span className="text-green-700">Accepted: see below how it goes</span>}
      </div>
      {error && (
        <div role="alert" className="text-red-600">
          {error}
        </div>
      )}
    </form>
  );
};

/**
 * The account's notifications: its webhooks' signing secret (owners), a test
 * (owners and developers), and how the latest deliveries went (everyone).
 */
const Notifications: React.FC = () => {
  const { account } = useSession();
  const [deliveries, setDeliveries] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setDeliveries((await notificationsApi.deliveries()).data);
      setError(null);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, account?.id]);
  const pending = deliveries ? anyPending(deliveries) : false;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [pending, load]);

  if (!account) return null;
  const active = account.status === 'active';

  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <h1 className="text-2xl font-bold mb-2">Notifications</h1>
      <p className="mb-6 text-gray-600">How FF tells this account what happens: by e-mail to its owners, and by webhooks, a POST of JSON to a URL of yours.</p>
      {!active && <p className="mb-6 text-sm text-gray-600">An account that isn't active can't send tests or rotate its secret.</p>}
      {account.role === 'owner' && <SigningSecret active={active} />}
      {active && can(account.role, 'change functions') && <SendTest onSent={load} />}
      <section className="card" aria-labelledby="deliveries">
        <h2 id="deliveries" className="text-lg font-semibold mb-1">
          Recent deliveries
        </h2>
        <p className="mb-4 text-sm text-gray-600">Kept 30 days. A failed one is tried again 1, 2, 4, 8 and 16 minutes later, then given up.</p>
        {error && (
          <div role="alert" className="mb-3 text-red-600">
            {error}
          </div>
        )}
        {deliveries === null && !error && <p className="text-gray-500">Loading…</p>}
        {deliveries?.length === 0 && <p className="text-gray-600">No notification yet.</p>}
        {deliveries && deliveries.length > 0 && (
          // On a phone, each delivery is a stacked item: a table's four columns don't fit.
          <ul className="space-y-3 md:hidden" aria-label="Recent deliveries">
            {deliveries.map((delivery) => {
              const outcome = deliveryOutcome(delivery);
              return (
                <li key={delivery.id} data-delivery={delivery.id} className="border-t border-gray-200 pt-3 text-sm">
                  <div>
                    <span className={`mr-2 inline-block rounded px-2 py-0.5 text-xs font-medium ${TONE[outcome.tone]}`}>{outcome.label}</span>{' '}
                    <span className="text-gray-700">{outcome.detail}</span>
                  </div>
                  <div className="mt-1 text-gray-600">
                    {formatWhen(delivery.createdAt)} · {channelLabel(delivery.channel)} · {delivery.kind}
                  </div>
                  <div className="break-all text-gray-900">{delivery.target}</div>
                </li>
              );
            })}
          </ul>
        )}
        {deliveries && deliveries.length > 0 && (
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-left text-sm" aria-label="Recent deliveries">
              <thead className="text-gray-600">
                <tr>
                  {['When', 'What', 'To', 'Outcome'].map((label) => (
                    <th key={label} className="py-2 pr-4 font-medium">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {deliveries.map((delivery) => {
                  const outcome = deliveryOutcome(delivery);
                  return (
                    <tr key={delivery.id} data-delivery={delivery.id} className="border-t border-gray-200 align-top">
                      <td className="whitespace-nowrap py-2 pr-4">{formatWhen(delivery.createdAt)}</td>
                      <td className="whitespace-nowrap py-2 pr-4">
                        {channelLabel(delivery.channel)} <span className="text-gray-500">· {delivery.kind}</span>
                      </td>
                      <td className="break-all py-2 pr-4">{delivery.target}</td>
                      <td className="py-2">
                        <span className={`mr-2 inline-block rounded px-2 py-0.5 text-xs font-medium ${TONE[outcome.tone]}`}>{outcome.label}</span>{' '}
                        <span className="text-gray-700">{outcome.detail}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default Notifications;
