import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TransferEntry, paymentsApi } from '../api';
import DataTable, { Column, Filter } from '../components/DataTable';
import ReasonDialog from '../components/ReasonDialog';
import { ErrorState } from '../components/States';
import { saveFile } from '../lib/download';
import { apiErrorMessage, notAnOperator } from '../lib/errors';
import { formatMoney } from '../lib/money';
import {
  AdminPayment,
  CERTIFICATE_MAX_MB,
  CERTIFICATE_TYPES,
  PAYMENT_STATUSES,
  certificateDue,
  certificateName,
  certificateProblem,
  paymentState,
  transferOutcome,
} from '../lib/payments';
import { TableQuery, currentCursor, firstPage, nextPage, pageNumber, pageParams, previousPage } from '../lib/table';
import { whenUtc } from '../lib/time';

const FILTERS: Filter[] = [
  { name: 'reference', label: 'Reference', placeholder: 'FF-7KQ2-9MXA' },
  { name: 'status', label: 'Status', options: PAYMENT_STATUSES },
  { name: 'accountId', label: 'Account', placeholder: '12 digits' },
];

/** Today, UTC: the latest day a transfer can be dated. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Recording a transfer from the bank statement (P-35): what arrived, what the
 * buyer withheld at source, the statement's date and reference. The dialog
 * says what the wallet gets before it is sent, or why it can't be.
 */
const RecordTransfer: React.FC<{ payment: AdminPayment; onDone: (payment: AdminPayment) => void; onCancel: () => void }> = ({ payment, onDone, onCancel }) => {
  const [received, setReceived] = useState(payment.total);
  const [withheld, setWithheld] = useState('0');
  const [receivedOn, setReceivedOn] = useState(today());
  const [bankReference, setBankReference] = useState('');
  const outcome = transferOutcome(payment, received, withheld);
  const { currency } = payment;

  const confirm = async (reason: string) => {
    if ('problem' in outcome) throw new Error(outcome.problem);
    const entry: TransferEntry = { reference: payment.reference, received: received.trim(), withheld: withheld.trim() || '0', receivedOn };
    if (bankReference.trim()) entry.bankReference = bankReference.trim();
    try {
      onDone((await paymentsApi.record(entry, reason)).data);
    } catch (error) {
      throw new Error(apiErrorMessage(error));
    }
  };

  return (
    <ReasonDialog title={`Record the transfer for ${payment.reference}`} confirmLabel="Record" onConfirm={confirm} onCancel={onCancel}>
      <p>
        {payment.buyer.name} ({payment.accountId}) asked for {formatMoney(payment.credit, currency)} of credit: {formatMoney(payment.total, currency)} with VAT.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="block font-medium">
          Received, in {currency}
          <input className="input mt-1" name="received" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} />
        </label>
        <label className="block font-medium">
          Withheld at source, in {currency}
          <input className="input mt-1" name="withheld" inputMode="decimal" value={withheld} onChange={(e) => setWithheld(e.target.value)} />
        </label>
        <label className="block font-medium">
          Date on the statement
          <input className="input mt-1" name="receivedOn" type="date" max={today()} value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
        </label>
        <label className="block font-medium">
          Bank's reference (optional)
          <input className="input mt-1" name="bankReference" maxLength={100} value={bankReference} onChange={(e) => setBankReference(e.target.value)} />
        </label>
      </div>
      <p aria-live="polite" className={`mt-3 ${'problem' in outcome ? 'text-red-700' : 'text-gray-700'}`}>
        {'problem' in outcome
          ? outcome.problem
          : `The wallet gets ${outcome.now} now${outcome.later ? `, and ${outcome.later} when you add the withholding certificate` : ''}. The owners get an e-mail.`}
      </p>
    </ReasonDialog>
  );
};

/** Adding the withholding certificate (P-35): it credits the share withheld at source. */
const AddCertificate: React.FC<{ payment: AdminPayment; onDone: (payment: AdminPayment) => void; onCancel: () => void }> = ({ payment, onDone, onCancel }) => {
  const [file, setFile] = useState<File | null>(null);
  const problem = file && certificateProblem(file);
  const withheld = formatMoney(payment.transfer?.withheld ?? '0', payment.currency);

  const confirm = async (reason: string) => {
    if (!file) throw new Error('Choose the certificate: a PDF, a PNG or a JPEG');
    if (problem) throw new Error(problem);
    try {
      onDone((await paymentsApi.addCertificate(payment.id, file, reason)).data);
    } catch (error) {
      throw new Error(apiErrorMessage(error));
    }
  };

  return (
    <ReasonDialog title={`Add the withholding certificate for ${payment.reference}`} confirmLabel="Add and credit" onConfirm={confirm} onCancel={onCancel}>
      <p>
        {payment.buyer.name} ({payment.accountId}) withheld {withheld} at source on this transfer. The certificate credits it to the account; the owners get an e-mail.
      </p>
      <label className="mt-3 block font-medium">
        Certificate: a PDF, a PNG or a JPEG, {CERTIFICATE_MAX_MB} MB at most
        <input className="mt-1 block" name="certificate" type="file" accept={CERTIFICATE_TYPES.join(',')} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      {problem && <p className="mt-2 text-red-700">{problem}</p>}
    </ReasonDialog>
  );
};

/**
 * Payments (P-35, P-74): the pro-formas owners asked for, newest first, and
 * the transfers recorded against them. An operator finds a transfer's
 * pro-forma by the reference in its label and records it, then adds the
 * withholding certificate when the buyer withheld a share at source.
 */
const Payments: React.FC<{ email: string | undefined; initial: Record<string, string> }> = ({ email, initial }) => {
  const [query, setQuery] = useState<TableQuery>({ search: '', filters: initial });
  const [paging, setPaging] = useState(firstPage());
  const [page, setPage] = useState<{ rows: AdminPayment[]; next: string | null } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [dialog, setDialog] = useState<{ kind: 'record' | 'certificate'; payment: AdminPayment } | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [changes, setChanges] = useState(0);

  const load = useCallback(async (current: TableQuery, before: string | null) => {
    setPage(null);
    setFailure(null);
    try {
      const { data } = await paymentsApi.page(pageParams(current, before));
      setPage({ rows: data.payments, next: data.next });
    } catch (error) {
      if (notAnOperator(error)) setRefused(true);
      else setFailure(apiErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load(query, currentCursor(paging));
  }, [load, query, paging, changes]);

  if (refused) return <ErrorState message={`You are logged in as ${email ?? 'someone'}, who isn't one of FF's operators.`} />;

  const done = (text: string) => {
    setDialog(null);
    setNotice({ ok: true, text });
    setChanges((n) => n + 1);
  };
  const download = async (payment: AdminPayment) => {
    setNotice(null);
    try {
      saveFile(certificateName(payment), (await paymentsApi.certificate(payment.id)).data);
    } catch (error) {
      setNotice({ ok: false, text: apiErrorMessage(error) });
    }
  };

  const columns: Array<Column<AdminPayment>> = [
    { label: 'Reference', cell: (payment) => <span className="font-mono">{payment.reference}</span>, className: 'whitespace-nowrap' },
    {
      label: 'Account',
      cell: (payment) => (
        <Link to={`/accounts/${payment.accountId}`} className="font-medium text-blue-700 hover:underline">
          {payment.buyer.name}
          <span className="block font-mono text-xs font-normal text-gray-500">{payment.accountId}</span>
        </Link>
      ),
    },
    { label: 'Asked for', cell: (payment) => whenUtc(payment.createdAt), className: 'whitespace-nowrap' },
    {
      label: 'To transfer',
      cell: (payment) => (
        <>
          {formatMoney(payment.total, payment.currency)}
          <span className="block text-xs text-gray-500">credit {formatMoney(payment.credit, payment.currency)}</span>
        </>
      ),
      className: 'whitespace-nowrap text-right tabular-nums',
    },
    {
      label: 'State',
      cell: (payment) => {
        const state = paymentState(payment);
        return (
          <>
            {state.label}
            {state.note && <span className="block text-gray-600">{state.note}</span>}
          </>
        );
      },
    },
    {
      label: 'Actions',
      cell: (payment) =>
        payment.status === 'pending' ? (
          <button type="button" className="btn btn-primary whitespace-nowrap" onClick={() => setDialog({ kind: 'record', payment })}>
            Record the transfer
          </button>
        ) : certificateDue(payment) ? (
          <button type="button" className="btn btn-primary whitespace-nowrap" onClick={() => setDialog({ kind: 'certificate', payment })}>
            Add the certificate
          </button>
        ) : payment.certificateType ? (
          <button type="button" className="btn btn-secondary whitespace-nowrap" onClick={() => void download(payment)}>
            Certificate
          </button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Payments</h1>
        <p className="text-gray-600">
          Pro-formas the owners asked for, newest first, and the transfers recorded against them. Find a transfer's pro-forma by the reference in its label, then
          record what the statement shows.
        </p>
      </div>
      {notice && (
        <p role={notice.ok ? 'status' : 'alert'} className={`rounded px-3 py-2 ${notice.ok ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-800'}`}>
          {notice.text}
        </p>
      )}
      <DataTable
        columns={columns}
        rows={page?.rows ?? null}
        rowKey={(payment) => payment.id}
        error={failure}
        empty="No payment matches."
        filters={FILTERS}
        initial={initial}
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
      {dialog?.kind === 'record' && (
        <RecordTransfer
          payment={dialog.payment}
          onCancel={() => setDialog(null)}
          onDone={(payment) =>
            done(`Recorded ${payment.reference}: ${formatMoney(payment.transfer?.credited ?? '0', payment.currency)} credited to ${payment.buyer.name}.`)
          }
        />
      )}
      {dialog?.kind === 'certificate' && (
        <AddCertificate
          payment={dialog.payment}
          onCancel={() => setDialog(null)}
          onDone={(payment) =>
            done(`Added the certificate for ${payment.reference}: ${formatMoney(payment.transfer?.withheld ?? '0', payment.currency)} credited to ${payment.buyer.name}.`)
          }
        />
      )}
    </div>
  );
};

export default Payments;
