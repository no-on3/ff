import React, { useEffect, useState } from 'react';
import { balanceLabel, invokesLabel, parsePercents, percentsText, transactionLabel, trialNote } from '../lib/billing';
import { apiErrorMessage } from '../lib/functions';
import { formatMoney } from '../lib/usage';
import { Alerts, BillingTransaction, billingApi } from '../services/api';
import { useSession } from '../session/session';
import { useBalance } from '../session/balance';

const Figure: React.FC<{ label: string; value: string; note?: string | null }> = ({ label, value, note }) => (
  <div className="card">
    <div className="text-sm text-gray-500">{label}</div>
    <div className="text-2xl font-semibold mt-1">{value}</div>
    {note && <div className="text-sm text-gray-600 mt-1">{note}</div>}
  </div>
);

/** The low-balance e-mails (P-33): every member sees the shares; an owner changes them. */
const LowBalanceEmails: React.FC<{ owner: boolean }> = ({ owner }) => {
  const [alerts, setAlerts] = useState<Alerts | null>(null);
  const [text, setText] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    billingApi
      .getAlerts()
      .then(({ data }) => {
        setAlerts(data);
        setText(percentsText(data.lowBalancePercents ?? data.defaultPercents));
      })
      .catch((failure) => setMessage({ ok: false, text: apiErrorMessage(failure) }));
  }, []);

  if (!alerts) return message ? <p role="alert" className="text-red-700">{message.text}</p> : null;
  const shares = alerts.lowBalancePercents ?? alerts.defaultPercents;

  const save = async (percents: number[] | null) => {
    setSaving(true);
    setMessage(null);
    try {
      const { data } = await billingApi.setAlerts(percents);
      setAlerts(data);
      setText(percentsText(data.lowBalancePercents ?? data.defaultPercents));
      setMessage({ ok: true, text: 'Saved.' });
    } catch (failure) {
      setMessage({ ok: false, text: apiErrorMessage(failure) });
    } finally {
      setSaving(false);
    }
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = parsePercents(text);
    if ('problem' in parsed) setMessage({ ok: false, text: parsed.problem });
    else void save(parsed.percents);
  };

  return (
    <div className="card space-y-3">
      <p>
        {shares.length === 0
          ? 'The owners get no low-balance e-mail.'
          : `The owners get an e-mail when the balance falls to ${shares.map((share) => `${share}%`).join(', ')} of the last credit.`}{' '}
        {alerts.lowBalancePercents === null && <span className="text-gray-600">These are FF's shares.</span>}
      </p>
      {owner && (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-gray-700 mb-1">Shares, in percent, largest first</span>
            <input
              aria-label="Shares"
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="rounded-md border border-gray-300 px-3 py-2 w-56"
              placeholder="50, 20, 0"
            />
          </label>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            Save
          </button>
          {alerts.lowBalancePercents !== null && (
            <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => void save(null)}>
              Use FF's ({percentsText(alerts.defaultPercents)})
            </button>
          )}
        </form>
      )}
      {message && (
        <p role={message.ok ? 'status' : 'alert'} className={message.ok ? 'text-green-700' : 'text-red-700'}>
          {message.text}
        </p>
      )}
    </div>
  );
};

/**
 * The account's money (P-32, P-33): its balance, whether invokes go on, this
 * month's charges, when the owners hear of a low balance, and what moved the
 * balance. Every member reads it.
 */
const Billing: React.FC = () => {
  const { account } = useSession();
  const { balance } = useBalance();
  const [transactions, setTransactions] = useState<BillingTransaction[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const accountId = account?.id;

  const load = (before?: string) =>
    billingApi
      .getTransactions(before)
      .then(({ data }) => {
        setTransactions((shown) => (before ? [...shown, ...data.transactions] : data.transactions));
        setNext(data.next);
      })
      .catch((failure) => setError(apiErrorMessage(failure)));

  useEffect(() => {
    void load();
  }, [accountId]);

  if (!account) return null;
  const trial = balance && trialNote(balance);
  return (
    <div className="container mx-auto px-4 space-y-8">
      <h1 className="text-2xl font-bold">Billing</h1>
      {balance && (
        <section className="grid gap-4 sm:grid-cols-3" aria-label="Balance">
          <Figure label="Balance" value={balanceLabel(balance)} />
          <Figure
            label="Charged this month"
            value={formatMoney(balance.charged, balance.currency)}
            note={balance.ratedUntil ? `Rated up to ${new Date(balance.ratedUntil).toISOString().slice(0, 16).replace('T', ' ')} UTC` : null}
          />
          <Figure label="Invokes" value={invokesLabel(balance)} />
        </section>
      )}
      {trial && <p className="text-blue-900 bg-blue-50 rounded px-3 py-2">{trial}</p>}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Adding credit</h2>
        <p className="card">Top-ups by card and bank transfer come with the next release. Until then, FF adds credit for you on request.</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Low-balance e-mails</h2>
        <LowBalanceEmails owner={account.role === 'owner'} />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">What moved the balance</h2>
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {transactions.length === 0 ? (
          <p className="card text-gray-600">Nothing yet: usage is charged every hour once billing starts, and credit appears here too.</p>
        ) : (
          <div className="card overflow-x-auto p-0">
            <table className="w-full text-left text-sm" aria-label="Transactions">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="px-4 py-2 font-medium">What</th>
                  <th className="px-4 py-2 font-medium">Written</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((transaction) => (
                  <tr key={transaction.id} className="border-t border-gray-200">
                    <td className="px-4 py-2">{transactionLabel(transaction)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{new Date(transaction.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC</td>
                    <td className={`px-4 py-2 text-right tabular-nums ${transaction.amount.startsWith('-') ? 'text-red-700' : 'text-green-700'}`}>
                      {formatMoney(transaction.amount, transaction.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {next && (
          <button type="button" className="btn btn-secondary" onClick={() => void load(next)}>
            Older
          </button>
        )}
      </section>
    </div>
  );
};

export default Billing;
