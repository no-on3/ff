import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { invoicesApi } from '../api';
import DataTable, { Column, Filter } from '../components/DataTable';
import ReasonDialog from '../components/ReasonDialog';
import { EmptyState, ErrorState, Loading } from '../components/States';
import { saveFile } from '../lib/download';
import { apiErrorMessage, notAnOperator } from '../lib/errors';
import { AdminInvoice, Draft, DraftsPage, INVOICE_KINDS, draftsTotal, invoiceFileName, invoiceLabel, issueNotice, lastMonthInTunisia, monthName } from '../lib/invoices';
import { formatMoney } from '../lib/money';
import { TableQuery, currentCursor, firstPage, nextPage, pageNumber, pageParams, previousPage } from '../lib/table';

const FILTERS: Filter[] = [
  { name: 'accountId', label: 'Account', placeholder: '12 digits' },
  { name: 'kind', label: 'Kind', options: INVOICE_KINDS },
  { name: 'month', label: 'Month', placeholder: '2026-10' },
];

/** A credit note against an invoice (D9: a correction, never an edit): what it gives back, before tax, at the invoice's VAT rate. */
const CreditNote: React.FC<{ invoice: AdminInvoice; onDone: (note: AdminInvoice) => void; onCancel: () => void }> = ({ invoice, onDone, onCancel }) => {
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');

  const confirm = async (reason: string) => {
    if (description.trim().length < 3) throw new Error('Say what the credit note gives back, in at least 3 characters: its line on the document');
    if (!/^\d{1,9}(\.\d{1,6})?$/.test(amount.trim())) throw new Error(`The amount before tax is an amount, such as ${invoice.subtotal}`);
    try {
      onDone((await invoicesApi.creditNote(invoice.id, [{ description: description.trim(), amount: amount.trim() }], reason)).data);
    } catch (error) {
      throw new Error(apiErrorMessage(error));
    }
  };

  return (
    <ReasonDialog title={`Issue a credit note for ${invoice.number}`} confirmLabel="Issue the credit note" onConfirm={confirm} onCancel={onCancel}>
      <p>
        {invoice.buyerName} ({invoice.accountId}): {invoiceLabel(invoice)}, {formatMoney(invoice.subtotal, invoice.currency)} before tax, {formatMoney(invoice.vat, invoice.currency)} of VAT. All its
        credit notes together give back no more. The VAT is added at the invoice's rate; no money moves: a refund is its own step.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block font-medium sm:col-span-2">
          Its line, in French, as the document shows it
          <input className="input mt-1" name="description" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Remboursement du crédit non consommé" />
        </label>
        <label className="block font-medium">
          Before tax, in {invoice.currency}
          <input className="input mt-1" name="amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
      </div>
    </ReasonDialog>
  );
};

/**
 * Invoices (P-36, P-74, D9): a month's drafts, worked out from the payments
 * not invoiced yet, to review and issue, all at once or one by one, once the
 * month is over; then every issued invoice and credit note, its PDF, and the
 * credit note that corrects an invoice.
 */
const Invoices: React.FC<{ email: string | undefined; initial: Record<string, string> }> = ({ email, initial }) => {
  const [month, setMonth] = useState(initial.month || lastMonthInTunisia(new Date()));
  const [drafts, setDrafts] = useState<DraftsPage | null>(null);
  const [draftsFailure, setDraftsFailure] = useState<string | null>(null);
  const [query, setQuery] = useState<TableQuery>({ search: '', filters: { accountId: initial.accountId ?? '', kind: initial.kind ?? '', month: '' } });
  const [paging, setPaging] = useState(firstPage());
  const [page, setPage] = useState<{ rows: AdminInvoice[]; next: string | null } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [dialog, setDialog] = useState<{ kind: 'issue'; drafts: Draft[] } | { kind: 'credit'; invoice: AdminInvoice } | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [changes, setChanges] = useState(0);

  useEffect(() => {
    setDrafts(null);
    setDraftsFailure(null);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      setDraftsFailure(`"${month}" is not a month, such as 2026-10`);
      return;
    }
    invoicesApi.drafts(month).then(
      ({ data }) => setDrafts(data),
      (error) => (notAnOperator(error) ? setRefused(true) : setDraftsFailure(apiErrorMessage(error))),
    );
  }, [month, changes]);

  const load = useCallback(async (current: TableQuery, before: string | null) => {
    setPage(null);
    setFailure(null);
    try {
      const { data } = await invoicesApi.page(pageParams(current, before));
      setPage({ rows: data.invoices, next: data.next });
    } catch (error) {
      if (notAnOperator(error)) setRefused(true);
      else setFailure(apiErrorMessage(error));
    }
  }, []);
  useEffect(() => {
    void load(query, currentCursor(paging));
  }, [load, query, paging, changes]);

  if (refused) return <ErrorState message={`You are logged in as ${email ?? 'someone'}, who isn't one of FF's operators.`} />;

  const download = async (invoice: AdminInvoice) => {
    setNotice(null);
    try {
      saveFile(invoiceFileName(invoice), (await invoicesApi.pdf(invoice.id)).data);
    } catch (error) {
      setNotice({ ok: false, text: apiErrorMessage(error) });
    }
  };
  const issue = async (chosen: Draft[], reason: string) => {
    try {
      const all = drafts !== null && chosen.length === drafts.drafts.length;
      const { data } = await invoicesApi.issue(month, all ? undefined : chosen.map((draft) => draft.accountId), reason);
      setDialog(null);
      setNotice(issueNotice(data));
      setChanges((n) => n + 1);
    } catch (error) {
      throw new Error(apiErrorMessage(error));
    }
  };

  const columns: Array<Column<AdminInvoice>> = [
    { label: 'Number', cell: (invoice) => <span className="font-mono">{invoice.number}</span>, className: 'whitespace-nowrap' },
    { label: 'What', cell: invoiceLabel },
    {
      label: 'Account',
      cell: (invoice) => (
        <Link to={`/accounts/${invoice.accountId}`} className="font-medium text-blue-700 hover:underline">
          {invoice.buyerName}
          <span className="block font-mono text-xs font-normal text-gray-500">{invoice.accountId}</span>
        </Link>
      ),
    },
    { label: 'Issued on', cell: (invoice) => invoice.issuedOn, className: 'whitespace-nowrap' },
    { label: 'Total', cell: (invoice) => formatMoney(invoice.total, invoice.currency), className: 'whitespace-nowrap text-right tabular-nums' },
    {
      label: 'Actions',
      cell: (invoice) => (
        <span className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-secondary" onClick={() => void download(invoice)}>
            PDF
          </button>
          {invoice.kind === 'invoice' && (
            <button type="button" className="btn btn-secondary whitespace-nowrap" onClick={() => setDialog({ kind: 'credit', invoice })}>
              Credit note
            </button>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Invoices</h1>
        <p className="text-gray-600">
          Each month an account paid in gets an invoice: a line per payment received up to the month's end and not invoiced yet. Review a month's drafts once it is over, and issue
          them: each is numbered, its stamp duty taken from the account's credit, its PDF written with the month's usage statement, and its owners told. An issued invoice never
          changes; a correction is a credit note.
        </p>
      </div>
      {notice && (
        <p role={notice.ok ? 'status' : 'alert'} className={`rounded px-3 py-2 ${notice.ok ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-800'}`}>
          {notice.text}
        </p>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <h2 className="text-lg font-semibold">Drafts</h2>
          <label className="text-sm">
            <span className="block text-gray-600">Month</span>
            <input className="input" type="month" aria-label="Month" value={month} onChange={(event) => setMonth(event.target.value)} />
          </label>
          {drafts && drafts.drafts.length > 0 && (
            <button type="button" className="btn btn-primary" disabled={!drafts.issuable} onClick={() => setDialog({ kind: 'issue', drafts: drafts.drafts })}>
              Issue all {drafts.drafts.length}
            </button>
          )}
        </div>
        {draftsFailure ? (
          <ErrorState message={draftsFailure} />
        ) : drafts === null ? (
          <Loading />
        ) : drafts.drafts.length === 0 ? (
          <EmptyState>No invoice to issue for {monthName(drafts.month)}.</EmptyState>
        ) : (
          <>
            {!drafts.issuable && <p className="text-amber-900">{monthName(drafts.month)} isn't over in Tunisia: its invoices are issued from the 1st of the next month.</p>}
            <div className="card overflow-x-auto p-0">
              <table className="w-full text-left text-sm" aria-label="Drafts">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    <th className="px-4 py-2 font-medium">Account</th>
                    <th className="px-4 py-2 font-medium">Payments</th>
                    <th className="px-4 py-2 text-right font-medium">Before tax</th>
                    <th className="px-4 py-2 text-right font-medium">VAT</th>
                    <th className="px-4 py-2 text-right font-medium">Stamp duty</th>
                    <th className="px-4 py-2 text-right font-medium">Total</th>
                    <th className="px-4 py-2 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {drafts.drafts.map((draft) => (
                    <tr key={draft.accountId} className="border-t border-gray-200 align-top">
                      <td className="px-4 py-2">
                        {draft.buyerName}
                        <span className="block font-mono text-xs text-gray-500">{draft.accountId}</span>
                      </td>
                      <td className="px-4 py-2">
                        {draft.lines.map((line) => (
                          <span key={line.paymentId} className="block whitespace-nowrap">
                            <span className="font-mono">{line.reference}</span>, {line.receivedOn}
                          </span>
                        ))}
                        {!/^0(\.0+)?$/.test(draft.withheld) && (
                          <span className="block text-gray-600">{formatMoney(draft.withheld, draft.currency)} withheld at source</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatMoney(draft.subtotal, draft.currency)}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatMoney(draft.vat, draft.currency)}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap">{formatMoney(draft.stampDuty, draft.currency)}</td>
                      <td className="px-4 py-2 text-right tabular-nums whitespace-nowrap font-semibold">{formatMoney(draft.total, draft.currency)}</td>
                      <td className="px-4 py-2 text-right">
                        <button type="button" className="btn btn-primary" disabled={!drafts.issuable} onClick={() => setDialog({ kind: 'issue', drafts: [draft] })}>
                          Issue
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Issued</h2>
        <DataTable
          columns={columns}
          rows={page?.rows ?? null}
          rowKey={(invoice) => invoice.id}
          error={failure}
          empty="No invoice or credit note matches."
          filters={FILTERS}
          initial={query.filters}
          onQuery={(next) => {
            setNotice(null);
            setQuery(next);
            setPaging(firstPage());
          }}
          page={pageNumber(paging)}
          hasNext={Boolean(page?.next)}
          onNext={() => page?.next && setPaging(nextPage(paging, page.next))}
          onPrevious={() => setPaging(previousPage(paging))}
        />
      </section>

      {dialog?.kind === 'issue' && (
        <ReasonDialog
          title={dialog.drafts.length === 1 ? `Issue ${dialog.drafts[0].buyerName}'s invoice for ${monthName(month)}?` : `Issue ${dialog.drafts.length} invoices for ${monthName(month)}?`}
          confirmLabel={dialog.drafts.length === 1 ? 'Issue it' : `Issue all ${dialog.drafts.length}`}
          onConfirm={(reason) => issue(dialog.drafts, reason)}
          onCancel={() => setDialog(null)}
        >
          <p>
            {draftsTotal(dialog.drafts)} in all, with the stamp duty. Each invoice is numbered, its stamp duty taken from the account's credit, its PDF written with the month's usage
            statement, and its owners told by e-mail. An issued invoice never changes: a correction is a credit note.
          </p>
        </ReasonDialog>
      )}
      {dialog?.kind === 'credit' && (
        <CreditNote
          invoice={dialog.invoice}
          onCancel={() => setDialog(null)}
          onDone={(note) => {
            setDialog(null);
            setNotice({ ok: true, text: `Issued ${note.number}: ${formatMoney(note.total, note.currency)} including VAT, for ${note.corrects ?? 'the invoice'}.` });
            setChanges((n) => n + 1);
          }}
        />
      )}
    </div>
  );
};

export default Invoices;
