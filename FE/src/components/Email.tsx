import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatWhen } from '../lib/accounts';
import {
  IDENTITY_STATUS_INFO,
  RECIPIENT_STATUS_INFO,
  RECORD_PURPOSES,
  addressList,
  identityProblem,
  lastDayLabel,
  quotaLabel,
  senders,
  sendingNotice,
  sesCommand,
} from '../lib/email';
import { apiErrorMessage } from '../lib/functions';
import { can } from '../lib/session';
import { EmailAccount, EmailIdentity, EmailMessage, EmailMetrics, Suppression, emailApi } from '../services/api';
import { useSession } from '../session/session';
import Copyable from './Copyable';
import Icon from './Icon';
import { Page, PageHeader } from './Page';
import { Callout, Panel } from './Panel';
import StatusPill from './StatusPill';

/** A domain's records, to publish at its DNS provider: each with what it is for, its name and value to copy. */
const Records: React.FC<{ identity: EmailIdentity }> = ({ identity }) => (
  <ul className="mt-3 space-y-3" aria-label={`The records of ${identity.identity}`}>
    {identity.records.map((record) => (
      <li key={`${record.purpose} ${record.name}`} className="rounded-md border border-line p-3">
        <p className="text-[13px] font-medium text-gray-700">
          {record.type} record · {RECORD_PURPOSES[record.purpose] ?? record.purpose}
        </p>
        <div className="mt-2 grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <Copyable value={record.name} label={`the ${record.purpose} record's name`} />
          <Copyable value={record.value} label={`the ${record.purpose} record's value`} />
        </div>
      </li>
    ))}
  </ul>
);

/** The domains and addresses mail goes from: each one's proof, a domain's records, and, for writers, adding, checking and deleting them. */
const Identities: React.FC<{ identities: EmailIdentity[]; writer: boolean; active: boolean; onChange(): Promise<void> }> = ({ identities, writer, active, onChange }) => {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const problem = name === '' ? null : identityProblem(name);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChange();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const add = (event: React.FormEvent) => {
    event.preventDefault();
    if (identityProblem(name)) return;
    void act(async () => {
      const made = (await emailApi.addIdentity(name.trim())).data;
      setName('');
      setOpen(made.identity);
    });
  };

  return (
    <Panel title="Domains and addresses" description="Mail goes from a domain proved by its DKIM record, which FF looks for every minute, or from an address proved by the link FF e-mails it." flush>
      {identities.length === 0 ? (
        <p className="px-5 py-6 text-gray-600">No domain or address yet: add one to send from.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {identities.map((identity) => {
            const status = IDENTITY_STATUS_INFO[identity.status];
            return (
              <li key={identity.identity} className="px-5 py-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-semibold break-all text-ink">{identity.identity}</span>
                    <span className="ml-2 text-xs text-gray-500">{identity.type === 'DOMAIN' ? 'domain' : 'address'}</span>
                    {identity.type === 'DOMAIN' && identity.status === 'SUCCESS' && !identity.mailFromVerified && (
                      <p className="text-xs text-gray-500">Its bounces come back to FF's own return path until its MX record is found.</p>
                    )}
                  </div>
                  <span className="inline-flex flex-wrap items-center gap-2">
                    <StatusPill tone={status.tone} label={status.label} title={status.title} />
                    {identity.type === 'DOMAIN' && (
                      <button type="button" className="btn btn-secondary" onClick={() => setOpen(open === identity.identity ? null : identity.identity)}>
                        {open === identity.identity ? 'Hide its records' : 'Its records'}
                      </button>
                    )}
                    {writer && active && identity.status !== 'SUCCESS' && (
                      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void act(() => emailApi.verifyIdentity(identity.identity))}>
                        {identity.type === 'DOMAIN' ? 'Check now' : 'Send its link again'}
                      </button>
                    )}
                    {writer &&
                      (deleting === identity.identity ? (
                        <span role="alertdialog" aria-label={`Delete ${identity.identity}`} className="inline-flex items-center gap-2">
                          <span className="text-[13px] text-gray-700">Delete it? No mail goes from it after.</span>
                          <button type="button" className="btn btn-primary" onClick={() => void act(() => emailApi.removeIdentity(identity.identity)).then(() => setDeleting(null))}>
                            Delete
                          </button>
                          <button type="button" className="btn btn-secondary" onClick={() => setDeleting(null)}>
                            Keep it
                          </button>
                        </span>
                      ) : (
                        <button type="button" className="btn btn-secondary" onClick={() => setDeleting(identity.identity)} aria-label={`Delete ${identity.identity}`}>
                          Delete
                        </button>
                      ))}
                  </span>
                </div>
                {open === identity.identity && identity.type === 'DOMAIN' && <Records identity={identity} />}
              </li>
            );
          })}
        </ul>
      )}
      {writer && active && (
        <form onSubmit={add} className="flex flex-wrap items-start gap-2 border-t border-line px-5 py-4" aria-label="Add a domain or an address">
          <div className="min-w-0 flex-1">
            <input aria-label="Domain or address" className="input w-full max-w-md font-mono" placeholder="shop.example.tn or orders@shop.example.tn" value={name} onChange={(e) => setName(e.target.value)} />
            {problem && <p className="mt-1 text-xs text-amber-900">{problem}</p>}
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || name === '' || !!problem}>
            Add
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="px-5 pb-4 text-red-700">
          {error}
        </p>
      )}
    </Panel>
  );
};

/** A message to try a domain or an address: from a proved one, to one in the sandbox's reach, as SendEmail sends it. */
const TestSend: React.FC<{ identities: EmailIdentity[]; onSent(): Promise<void> }> = ({ identities, onSent }) => {
  const choices = senders(identities);
  const [from, setFrom] = useState(choices[0] ?? '');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('A test from FF');
  const [text, setText] = useState('Sent from the console, through FF.');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  if (choices.length === 0) return null;
  const send = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const { messageId } = (await emailApi.send({ from, to: addressList(to), subject, text })).data;
      setResult({ ok: true, text: `Queued: ${messageId}. Its recipients' fate shows below.` });
      await onSent();
    } catch (failure) {
      setResult({ ok: false, text: apiErrorMessage(failure) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Panel title="Send a test" description="In the sandbox, to the addresses and domains you proved. Your code sends with AWS's SDKs and CLI, AWS_ENDPOINT_URL_SESV2 set, as a function's environment sets it.">
      <form onSubmit={send} className="grid gap-3 md:grid-cols-2" aria-label="Send a test message">
        <label className="text-[13px] font-medium text-gray-700">
          From
          <input className="input mt-1 w-full font-mono" list="email-senders" value={from} onChange={(e) => setFrom(e.target.value)} />
          <datalist id="email-senders">
            {choices.map((choice) => (
              <option key={choice} value={choice} />
            ))}
          </datalist>
        </label>
        <label className="text-[13px] font-medium text-gray-700">
          To
          <input className="input mt-1 w-full font-mono" placeholder="ana@shop.example.tn" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="text-[13px] font-medium text-gray-700 md:col-span-2">
          Subject
          <input className="input mt-1 w-full" value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label className="text-[13px] font-medium text-gray-700 md:col-span-2">
          Text
          <textarea className="input mt-1 min-h-20 w-full" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <div className="flex flex-wrap items-center gap-3 md:col-span-2">
          <button type="submit" className="btn btn-primary" disabled={busy || from === '' || addressList(to).length === 0 || subject === ''}>
            {busy ? 'Sending…' : 'Send'}
          </button>
          {result && (
            <p role={result.ok ? 'status' : 'alert'} className={`text-[13px] ${result.ok ? 'text-green-800' : 'text-red-700'}`}>
              {result.text}
            </p>
          )}
        </div>
      </form>
      {from !== '' && addressList(to).length > 0 && (
        <div className="mt-4">
          <p className="mb-1.5 text-[13px] font-medium text-gray-700">The same, from a terminal</p>
          <Copyable value={sesCommand(from, addressList(to)[0])} label="the AWS CLI's command" />
        </div>
      )}
    </Panel>
  );
};

/** The latest messages, and what became of each recipient. */
const Messages: React.FC<{ messages: EmailMessage[] }> = ({ messages }) => (
  <Panel title="Latest messages" description="Through the SES endpoint or this page, the latest first, kept 30 days." flush>
    {messages.length === 0 ? (
      <p className="px-5 py-6 text-gray-600">No message sent yet.</p>
    ) : (
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="bg-gray-50/70 text-xs text-gray-500">
            <tr className="border-b border-line">
              <th scope="col" className="px-3.5 py-2.5 font-medium">Sent</th>
              <th scope="col" className="px-3.5 py-2.5 font-medium">From</th>
              <th scope="col" className="px-3.5 py-2.5 font-medium">Recipients</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {messages.map((message) => (
              <tr key={message.messageId}>
                <td className="px-3.5 py-3 whitespace-nowrap text-gray-600" title={message.messageId}>
                  {formatWhen(message.createdAt)}
                </td>
                <td className="px-3.5 py-3 font-mono text-[13px] break-all">{message.from}</td>
                <td className="px-3.5 py-3">
                  <ul className="space-y-1">
                    {message.recipients.map((recipient) => {
                      const info = RECIPIENT_STATUS_INFO[recipient.status];
                      return (
                        <li key={recipient.address} className="flex flex-wrap items-center gap-2 text-[13px]">
                          <span className="font-mono break-all">{recipient.address}</span>
                          <StatusPill tone={info.tone} label={info.label} title={recipient.diagnostic ?? undefined} />
                        </li>
                      );
                    })}
                  </ul>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
  </Panel>
);

/** The suppression list: the addresses no mail of the account goes to, put there by their bounces and complaints, or by hand. */
const Suppressions: React.FC<{ suppressions: Suppression[]; writer: boolean; active: boolean; onChange(): Promise<void> }> = ({ suppressions, writer, active, onChange }) => {
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const act = async (work: () => Promise<unknown>) => {
    setError(null);
    try {
      await work();
      await onChange();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  };
  return (
    <Panel title="Suppression list" description="A bounce for good, or a complaint, puts an address here, as SES does: no mail of yours goes to it while it is." flush>
      {suppressions.length === 0 ? (
        <p className="px-5 py-6 text-gray-600">No address on it.</p>
      ) : (
        <ul className="divide-y divide-gray-100">
          {suppressions.map((one) => (
            <li key={one.address} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <span className="min-w-0">
                <span className="font-mono break-all">{one.address}</span>
                <span className="ml-2 text-xs text-gray-500">
                  {one.reason === 'BOUNCE' ? 'bounced' : 'complained'}, {formatWhen(one.updatedAt)}
                  {one.feedback ? `: ${one.feedback}` : ''}
                </span>
              </span>
              {writer && (
                <button type="button" className="btn btn-secondary" onClick={() => void act(() => emailApi.unsuppress(one.address))} aria-label={`Take ${one.address} off`}>
                  Take off
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {writer && active && (
        <form
          className="flex flex-wrap items-center gap-2 border-t border-line px-5 py-4"
          aria-label="Put an address on the suppression list"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await emailApi.suppress(address.trim(), 'BOUNCE');
              setAddress('');
            });
          }}
        >
          <input aria-label="Address to suppress" className="input w-full max-w-sm font-mono" placeholder="gone@example.tn" value={address} onChange={(e) => setAddress(e.target.value)} />
          <button type="submit" className="btn btn-secondary" disabled={address.trim() === ''}>
            Put on the list
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="px-5 pb-4 text-red-700">
          {error}
        </p>
      )}
    </Panel>
  );
};

/** The last day's mail, from its hourly metrics, as CloudWatch names SES's; an alarm on them is made on the Alarms page. */
const LastDay: React.FC<{ alarms: boolean }> = ({ alarms }) => {
  const [metrics, setMetrics] = useState<EmailMetrics | null>(null);
  useEffect(() => {
    let current = true;
    const start = new Date(Date.now() - 23 * 3_600_000).toISOString();
    emailApi
      .metrics({ start })
      .then(({ data }) => current && setMetrics(data))
      .catch(() => current && setMetrics(null));
    return () => {
      current = false;
    };
  }, []);
  if (!metrics) return null;
  return (
    <p className="mt-2 text-sm text-gray-600" aria-label="The last day's mail">
      {lastDayLabel(metrics)}{' '}
      {alarms && (
        <Link to="/alarms?mail=bounces" className="text-blue-700 hover:underline">
          Add an alarm
        </Link>
      )}
    </p>
  );
};

/**
 * Customers' mail, as AWS SES v2 gives it (ADR 0012): the account's sending,
 * its quotas and its sandbox; the domains and addresses it goes from, with
 * the records a domain publishes; a test, the latest messages and what became
 * of each recipient; the suppression list. Every member sees them; owners and
 * developers of an active account add, prove and send.
 */
const Email: React.FC = () => {
  const { account } = useSession();
  const [sending, setSending] = useState<EmailAccount | null>(null);
  const [identities, setIdentities] = useState<EmailIdentity[] | null>(null);
  const [messages, setMessages] = useState<EmailMessage[]>([]);
  const [suppressions, setSuppressions] = useState<Suppression[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [state, listed, latest, suppressed] = await Promise.all([emailApi.account(), emailApi.identities(), emailApi.messages(), emailApi.suppressions()]);
      setSending(state.data);
      setIdentities(listed.data);
      setMessages(latest.data.messages);
      setSuppressions(suppressed.data.suppressions);
      setError(null);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, account?.id]);

  if (!account) return null;
  const writer = can(account.role, 'change email');
  const active = account.status === 'active';
  const notice = sending ? sendingNotice(sending) : null;

  return (
    <Page>
      <PageHeader
        title="E-mail"
        description="Your app's mail, with AWS SES v2's API and its SDKs: from your own domains, signed with each one's DKIM key, sent from FF's mail server, its bounces and complaints back on your suppression list."
      />
      {error && (
        <p role="alert" className="mb-4 text-red-700">
          {error}
        </p>
      )}
      {sending === null || identities === null ? (
        !error && <p className="py-10 text-center text-gray-500">Loading…</p>
      ) : (
        <div className="space-y-6">
          <Panel title="Sending" aria-label="The account's sending">
            <p className="flex items-center gap-2 text-ink">
              <Icon name="email" />
              {quotaLabel(sending)}
            </p>
            <LastDay alarms={can(account.role, 'change functions') && active} />
            {notice && (
              <Callout tone={sending.sendingEnabled && sending.enforcementStatus !== 'SHUTDOWN' ? 'info' : 'danger'} className="mt-3">
                {notice}
              </Callout>
            )}
          </Panel>
          <Identities identities={identities} writer={writer} active={active} onChange={load} />
          {writer && active && <TestSend identities={identities} onSent={load} />}
          <Messages messages={messages} />
          <Suppressions suppressions={suppressions} writer={writer} active={active} onChange={load} />
        </div>
      )}
    </Page>
  );
};

export default Email;
