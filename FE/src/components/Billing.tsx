import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  CREDIT_PACKS,
  balanceLabel,
  decimalsOf,
  invoiceKindLabel,
  invokesLabel,
  monthName,
  parsePercents,
  percentsText,
  proFormaQuote,
  proFormaState,
  statementMonths,
  transactionLabel,
  trialNote,
} from '../lib/billing';
import { saveFile } from '../lib/download';
import { apiErrorMessage } from '../lib/functions';
import { formatMoney } from '../lib/usage';
import { Alerts, BillingTransaction, Invoice, ProForma, billingApi } from '../services/api';
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

const OTHER = 'other';

/**
 * Adding credit (P-35, D9): an owner asks for a pro-forma for a pack or
 * another amount, and gets the total to transfer, FF's bank account and the
 * reference for the transfer's label; every member sees the account's
 * pro-formas and where each one stands. The currency and its decimals are the
 * balance's.
 */
const AddingCredit: React.FC<{ owner: boolean; currency: string | null; decimals: number | null }> = ({ owner, currency, decimals }) => {
  const navigate = useNavigate();
  const [proFormas, setProFormas] = useState<ProForma[] | null>(null);
  const [vatPercent, setVatPercent] = useState<number | null>(null);
  const [choice, setChoice] = useState(CREDIT_PACKS[1]);
  const [other, setOther] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    billingApi
      .getProFormas()
      .then(({ data }) => {
        setProFormas(data.proFormas);
        setVatPercent(data.vatPercent);
      })
      .catch((failure) => setProblem(apiErrorMessage(failure)));
  }, []);

  const quote = decimals === null || vatPercent === null ? null : proFormaQuote(choice === OTHER ? other : choice, decimals, vatPercent);
  const ask = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!quote || 'problem' in quote) {
      setProblem(quote ? quote.problem : 'The balance or the VAT rate did not load: try again in a moment');
      return;
    }
    setAsking(true);
    setProblem(null);
    try {
      const { data } = await billingApi.requestProForma(quote.credit);
      navigate(`/billing/pro-formas/${data.id}`);
    } catch (failure) {
      setProblem(apiErrorMessage(failure));
      setAsking(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="card">
        Credit comes by bank transfer. {owner ? 'Ask' : 'An owner of the account asks'} for a pro-forma: it gives the total to transfer, with VAT on top of the credit
        {vatPercent === null ? '' : ` (${vatPercent}%)`}, FF's bank account, and a reference to write in the transfer's label. FF adds the credit when the transfer arrives; a share withheld at source is added when FF receives the withholding certificate.
      </p>
      {owner && currency && (
        <form onSubmit={(event) => void ask(event)} className="card space-y-4" aria-label="Ask for a pro-forma">
          <fieldset className="flex flex-wrap gap-3">
            <legend className="text-sm text-gray-700 mb-2">Credit, before VAT</legend>
            {[...CREDIT_PACKS, OTHER].map((option) => (
              <label key={option} className={`flex items-center gap-2 rounded-md border px-3 py-2 ${choice === option ? 'border-blue-600 bg-blue-50' : 'border-gray-300'}`}>
                <input type="radio" name="credit" value={option} checked={choice === option} onChange={() => setChoice(option)} />
                {option === OTHER ? 'Another amount' : formatMoney(option, currency)}
              </label>
            ))}
          </fieldset>
          {choice === OTHER && (
            <label className="block text-sm">
              <span className="block text-gray-700 mb-1">Amount, in {currency}</span>
              <input aria-label="Amount" value={other} onChange={(event) => setOther(event.target.value)} className="rounded-md border border-gray-300 px-3 py-2 w-48" placeholder="250" inputMode="decimal" />
            </label>
          )}
          {quote && 'credit' in quote && (
            <p aria-label="Quote" className="tabular-nums">
              {formatMoney(quote.credit, currency)} of credit + {formatMoney(quote.vat, currency)} VAT ({vatPercent}%) = <strong>{formatMoney(quote.total, currency)}</strong> to transfer
            </p>
          )}
          <button type="submit" className="btn btn-primary" disabled={asking}>
            Get the pro-forma
          </button>
        </form>
      )}
      {problem && (
        <p role="alert" className="text-red-700">
          {problem}
        </p>
      )}
      {proFormas && proFormas.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm" aria-label="Pro-formas">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-4 py-2 font-medium">Reference</th>
                <th className="px-4 py-2 font-medium">Asked for</th>
                <th className="px-4 py-2 text-right font-medium">Credit</th>
                <th className="px-4 py-2 text-right font-medium">To transfer</th>
                <th className="px-4 py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {proFormas.map((proForma) => {
                const state = proFormaState(proForma);
                return (
                  <tr key={proForma.id} className="border-t border-gray-200 align-top">
                    <td className="px-4 py-2 whitespace-nowrap font-mono">
                      <Link to={`/billing/pro-formas/${proForma.id}`}>{proForma.reference}</Link>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">{proForma.createdAt.slice(0, 10)}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatMoney(proForma.credit, proForma.currency)}</td>
                    <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatMoney(proForma.total, proForma.currency)}</td>
                    <td className="px-4 py-2">
                      {state.label}
                      {state.note && <div className="text-gray-600">{state.note}</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/**
 * Invoices and usage statements (P-36, D9): each month the account bought
 * credit in gets an invoice, in French, once FF issues it early the next
 * month, with the month's usage statement attached; a correction is a credit
 * note. Every month has a usage statement. Every member downloads them.
 */
const Invoices: React.FC = () => {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const months = useMemo(() => statementMonths(new Date()), []);
  const [month, setMonth] = useState(months[1]);

  useEffect(() => {
    billingApi
      .getInvoices()
      .then(({ data }) => setInvoices(data.invoices))
      .catch((failure) => setProblem(apiErrorMessage(failure)));
  }, []);

  const download = async (load: () => Promise<{ data: Blob }>, name: string) => {
    setProblem(null);
    try {
      saveFile(name, (await load()).data);
    } catch (failure) {
      setProblem(apiErrorMessage(failure));
    }
  };

  return (
    <div className="space-y-4">
      <p className="card">
        Each month you buy credit in gets an invoice, in French, issued early the next month: a line per transfer, the VAT, and the stamp duty, which is taken from your credit.
        The month's usage statement is attached to it. Every month has a usage statement, with or without an invoice.
      </p>
      {invoices && invoices.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm" aria-label="Invoices">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="px-4 py-2 font-medium">Number</th>
                <th className="px-4 py-2 font-medium">What</th>
                <th className="px-4 py-2 font-medium">Issued on</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {invoices.map((invoice) => (
                <tr key={invoice.id} className="border-t border-gray-200">
                  <td className="px-4 py-2 whitespace-nowrap font-mono">{invoice.number}</td>
                  <td className="px-4 py-2">{invoice.month ? `${invoiceKindLabel(invoice)}, ${monthName(invoice.month)}` : invoiceKindLabel(invoice)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{invoice.issuedOn}</td>
                  <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatMoney(invoice.total, invoice.currency)}</td>
                  <td className="px-4 py-2 text-right">
                    <button type="button" className="btn btn-secondary" onClick={() => void download(() => billingApi.getInvoicePdf(invoice.id), `${invoice.number}.pdf`)}>
                      PDF
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {invoices && invoices.length === 0 && <p className="text-gray-600">No invoice yet.</p>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="block text-gray-700 mb-1">Usage statement</span>
          <select aria-label="Statement month" value={month} onChange={(event) => setMonth(event.target.value)} className="rounded-md border border-gray-300 px-3 py-2">
            {months.map((option) => (
              <option key={option} value={option}>
                {monthName(option)}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-secondary" onClick={() => void download(() => billingApi.getStatementPdf(month), `releve-${month}.pdf`)}>
          Download the statement
        </button>
      </div>
      {problem && (
        <p role="alert" className="text-red-700">
          {problem}
        </p>
      )}
    </div>
  );
};

/**
 * The account's money (P-32, P-33, P-35, P-36): its balance, whether invokes go on,
 * this month's charges, adding credit, invoices and statements, when the owners hear of a low balance,
 * and what moved the balance. Every member reads it.
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
        <AddingCredit owner={account.role === 'owner'} currency={balance?.currency ?? null} decimals={balance ? decimalsOf(balance.balance) : null} />
      </section>

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">Invoices and usage statements</h2>
        <Invoices />
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
