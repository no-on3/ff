import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AccountAuditEntry, accountsApi, invoicesApi, paymentsApi, plansApi } from '../api';
import DataTable, { Column } from '../components/DataTable';
import GrantDialog from '../components/GrantDialog';
import ReasonDialog from '../components/ReasonDialog';
import { Fact, Table } from '../components/Facts';
import { EmptyState, ErrorState, Loading } from '../components/States';
import StatusBadge from '../components/StatusBadge';
import {
  AccountView,
  PlanOption,
  STATUS_CHANGES,
  StatusChange,
  changedNotice,
  changesFor,
  dataDeletion,
  bucketStorageLabel,
  formatMegabytes,
  isAccountId,
  ownersSee,
  storageLabel,
} from '../lib/accounts';
import { actionLabel, describeAction } from '../lib/audit';
import { GrantRequest, chargesLabel, creditStateLabel, grantNotice } from '../lib/credits';
import { apiErrorMessage, notAnOperator } from '../lib/errors';
import { balanceNote, formatMoney } from '../lib/money';
import { AdminInvoice, invoiceLabel } from '../lib/invoices';
import { AdminPayment, paymentState } from '../lib/payments';
import { currentCursor, firstPage, nextPage, pageNumber, previousPage } from '../lib/table';
import { whenUtc } from '../lib/time';

/** The change waiting for its reason, in the dialog. */
type Pending = { kind: 'status'; change: StatusChange } | { kind: 'plan'; planId: string } | { kind: 'egress'; on: boolean } | { kind: 'storage'; on: boolean };

const AUDIT_COLUMNS: Array<Column<AccountAuditEntry>> = [
  { label: 'When', cell: (entry) => whenUtc(entry.at), className: 'whitespace-nowrap' },
  { label: 'Who', cell: (entry) => entry.actorLabel },
  { label: 'Action', cell: (entry) => actionLabel(entry.action), className: 'whitespace-nowrap' },
  { label: 'What', cell: (entry) => describeAction(entry) },
  { label: 'Reason', cell: (entry) => (typeof entry.details?.reason === 'string' ? entry.details.reason : '') },
];


/** The account's last payments (P-35), with a link to the Payments page, where transfers are recorded. */
const AccountPayments: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [payments, setPayments] = useState<{ rows: AdminPayment[]; more: boolean } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    paymentsApi.page({ accountId, limit: '5' }).then(
      ({ data }) => setPayments({ rows: data.payments, more: data.next !== null }),
      (error) => setFailure(apiErrorMessage(error)),
    );
  }, [accountId]);

  if (failure) return <ErrorState message={failure} />;
  if (!payments) return <Loading />;
  if (payments.rows.length === 0) return <EmptyState>No pro-forma asked for yet.</EmptyState>;
  return (
    <>
      <Table
        head={['Reference', 'Asked for', 'To transfer', 'State']}
        rows={payments.rows.map((payment) => {
          const state = paymentState(payment);
          return [
            <span key="reference" className="whitespace-nowrap font-mono">
              {payment.reference}
            </span>,
            whenUtc(payment.createdAt),
            <span key="total" className="whitespace-nowrap">
              {formatMoney(payment.total, payment.currency)}
            </span>,
            state.note ? `${state.label}; ${state.note}` : state.label,
          ];
        })}
      />
      <Link to={`/payments?accountId=${accountId}`} className="text-sm text-blue-700 hover:underline">
        {payments.more ? 'All its payments' : 'On the Payments page'}, to record a transfer or add a certificate →
      </Link>
    </>
  );
};

/** The account's last invoices and credit notes (P-36), with a link to the Invoices page, where they are issued and corrected. */
const AccountInvoices: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [invoices, setInvoices] = useState<{ rows: AdminInvoice[]; more: boolean } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    invoicesApi.page({ accountId, limit: '5' }).then(
      ({ data }) => setInvoices({ rows: data.invoices, more: data.next !== null }),
      (error) => setFailure(apiErrorMessage(error)),
    );
  }, [accountId]);

  if (failure) return <ErrorState message={failure} />;
  if (!invoices) return <Loading />;
  if (invoices.rows.length === 0) return <EmptyState>No invoice issued yet.</EmptyState>;
  return (
    <>
      <Table
        head={['Number', 'What', 'Issued on', 'Total']}
        rows={invoices.rows.map((invoice) => [
          <span key="number" className="whitespace-nowrap font-mono">
            {invoice.number}
          </span>,
          invoiceLabel(invoice),
          invoice.issuedOn,
          <span key="total" className="whitespace-nowrap">
            {formatMoney(invoice.total, invoice.currency)}
          </span>,
        ])}
      />
      <Link to={`/invoices?accountId=${accountId}`} className="text-sm text-blue-700 hover:underline">
        {invoices.more ? 'All its invoices' : 'On the Invoices page'}, to download them or issue a credit note →
      </Link>
    </>
  );
};

/**
 * One account (P-71): what sign-up collected, its people, functions, this
 * month's usage, its credit (P-74), payments and invoices, and its history,
 * and the operator's changes, each with a reason that goes to the account's
 * audit log: a grant of credit among them.
 */
const Account: React.FC<{ email: string | undefined }> = ({ email }) => {
  const { id } = useParams();
  const [view, setView] = useState<AccountView | null>(null);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [planChoice, setPlanChoice] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [granting, setGranting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [auditPaging, setAuditPaging] = useState(firstPage());
  const [audit, setAudit] = useState<{ rows: AccountAuditEntry[]; next: string | null } | null>(null);
  const [auditFailure, setAuditFailure] = useState<string | null>(null);
  const [changes, setChanges] = useState(0);

  useEffect(() => {
    if (!isAccountId(id)) return;
    accountsApi.get(id).then(
      ({ data }) => {
        setView(data);
        setPlanChoice(data.account.planId);
      },
      (error) => (notAnOperator(error) ? setRefused(true) : setFailure(apiErrorMessage(error))),
    );
    plansApi.list().then(({ data }) => setPlans(data), () => undefined);
  }, [id]);

  const loadAudit = useCallback(
    async (before: string | null) => {
      if (!isAccountId(id)) return;
      setAudit(null);
      setAuditFailure(null);
      try {
        const { data } = await accountsApi.auditLog(id, { limit: '20', ...(before ? { before } : {}) });
        setAudit({ rows: data.entries, next: data.next });
      } catch (error) {
        setAuditFailure(apiErrorMessage(error));
      }
    },
    [id],
  );
  useEffect(() => {
    void loadAudit(currentCursor(auditPaging));
  }, [loadAudit, auditPaging, changes]);

  if (!isAccountId(id)) return <ErrorState message={`"${id ?? ''}" isn't an account ID: those are 12 digits.`} />;
  if (refused) return <ErrorState message={`You are logged in as ${email ?? 'someone'}, who isn't one of FF's operators.`} />;
  if (failure) return <ErrorState message={failure} />;
  if (!view) return <Loading />;

  const { account } = view;
  const confirm = async (reason: string) => {
    if (!pending) return;
    try {
      const { data } =
        pending.kind === 'status'
          ? await accountsApi.change(account.id, pending.change, reason)
          : pending.kind === 'plan'
            ? await accountsApi.plan(account.id, pending.planId, reason)
            : pending.kind === 'storage'
              ? await accountsApi.storage(account.id, pending.on, reason)
              : await accountsApi.egress(account.id, pending.on, reason);
      setView(data);
      setPlanChoice(data.account.planId);
      setNotice(pending.kind === 'status' ? changedNotice(pending.change) : 'Saved.');
      setPending(null);
      setAuditPaging(firstPage());
      setChanges((n) => n + 1);
    } catch (error) {
      throw new Error(apiErrorMessage(error));
    }
  };
  const dialog = (() => {
    if (!pending) return null;
    if (pending.kind === 'status') {
      const info = STATUS_CHANGES[pending.change];
      return {
        title: `${info.label} ${account.name}?`,
        body: (
          <>
            <p>{info.effect}</p>
            <p className="mt-2 text-gray-600">{ownersSee(pending.change)}</p>
          </>
        ),
        confirmLabel: info.label,
      };
    }
    if (pending.kind === 'plan') {
      return {
        title: `Move ${account.name} to another plan?`,
        body: <p>Plan: {account.planId} → {pending.planId}. Its quota changes at once.</p>,
        confirmLabel: 'Change plan',
      };
    }
    if (pending.kind === 'storage') {
      return {
        title: `Turn ${account.name}'s databases and buckets ${pending.on ? 'on' : 'off'}?`,
        body: (
          <p>
            {pending.on
              ? "Its databases' users log in again, unless the account is suspended or closed."
              : "Its databases' users can't log in, their sessions end, and it can make no database. Their data stay, and are billed; its functions go on."}{' '}
            Its owners get an e-mail that gives your reason, and its members read it in their audit log.
          </p>
        ),
        confirmLabel: pending.on ? 'Turn on' : 'Turn off',
      };
    }
    return {
      title: `Turn internet egress ${pending.on ? 'on' : 'off'} for ${account.name}?`,
      body: (
        <p>
          Internet egress: {account.internetEgress ? 'on' : 'off'} → {pending.on ? 'on' : 'off'}.{' '}
          {pending.on
            ? "Its functions can then open connections to the internet, never to FF's own network."
            : 'Its functions can then open no connection beyond name lookups.'}{' '}
          The account's network policy changes at once; if the cluster refuses it, nothing changes.
        </p>
      ),
      confirmLabel: pending.on ? 'Turn on' : 'Turn off',
    };
  })();
  const grant = async (request: GrantRequest) => {
    try {
      const { data } = await accountsApi.grant(account.id, request);
      setView(data.account);
      setNotice(grantNotice(data.grant));
      setGranting(false);
      setAuditPaging(firstPage());
      setChanges((n) => n + 1);
    } catch (error) {
      throw new Error(apiErrorMessage(error));
    }
  };
  const { totals } = view.usage;
  const { credit } = view;
  const otherWallets = view.balances.filter(({ currency }) => currency !== credit.currency);

  return (
    <div className="space-y-8">
      <div className="space-y-3">
        <Link to="/accounts" className="text-sm text-blue-700 hover:underline">
          ← Accounts
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{account.name}</h1>
          <StatusBadge status={account.status} />
          <span className="font-mono text-sm text-gray-500">{account.id}</span>
        </div>
        <div className="flex flex-wrap gap-3">
          {changesFor(account.status).map((change) => (
            <button
              key={change}
              type="button"
              className={STATUS_CHANGES[change].stops ? 'btn btn-secondary' : 'btn btn-primary'}
              onClick={() => {
                setNotice(null);
                setPending({ kind: 'status', change });
              }}
            >
              {STATUS_CHANGES[change].label}
            </button>
          ))}
        </div>
        {notice && (
          <p role="status" className="rounded bg-green-50 px-3 py-2 text-green-900">
            {notice}
          </p>
        )}
      </div>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">The account</h2>
        <dl className="card space-y-3">
          <Fact label="Owners">{account.owners.map((owner) => (owner.name ? `${owner.name} <${owner.email}>` : owner.email)).join(', ') || '–'}</Fact>
          <Fact label="What they plan to build">{account.useCase ?? '–'}</Fact>
          <Fact label="Country">{account.country}</Fact>
          <Fact label="Tax ID">{account.taxId ?? '–'}</Fact>
          <Fact label="Created">{whenUtc(account.createdAt)}</Fact>
          {dataDeletion(account, whenUtc) && <Fact label="Its data">{dataDeletion(account, whenUtc)}</Fact>}
          <Fact label="Plan">
            <span className="flex flex-wrap items-center gap-2">
              <select aria-label="Plan" className="input max-w-xs" value={planChoice} onChange={(e) => setPlanChoice(e.target.value)}>
                {(plans.length ? plans : [{ id: account.planId, name: account.planId }]).map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} ({plan.id})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={planChoice === account.planId}
                onClick={() => {
                  setNotice(null);
                  setPending({ kind: 'plan', planId: planChoice });
                }}
              >
                Change plan
              </button>
            </span>
          </Fact>
          <Fact label="Internet egress">
            <span className="flex flex-wrap items-center gap-3">
              {account.internetEgress ? 'On' : 'Off'}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setNotice(null);
                  setPending({ kind: 'egress', on: !account.internetEgress });
                }}
              >
                {account.internetEgress ? 'Turn off' : 'Turn on'}
              </button>
            </span>
          </Fact>
          <Fact label="Databases and buckets">
            <span className="flex flex-wrap items-center gap-3">
              {storageLabel(account, whenUtc)}
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setNotice(null);
                  setPending({ kind: 'storage', on: account.storageDisabledAt !== null });
                }}
              >
                {account.storageDisabledAt ? 'Turn on' : 'Turn off'}
              </button>
            </span>
          </Fact>
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Owners and members</h2>
        {view.members.length === 0 ? (
          <EmptyState>No member.</EmptyState>
        ) : (
          <Table head={['E-mail', 'Name', 'Role', 'Joined']} rows={view.members.map((m) => [m.email, m.name ?? '', m.role, whenUtc(m.joinedAt)])} />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Functions</h2>
        {view.functions.length === 0 ? (
          <EmptyState>No function.</EmptyState>
        ) : (
          <Table
            head={['Name', 'Runtime', 'Memory', 'Status', 'Warm instances', 'Last call']}
            rows={view.functions.map((f) => [<Link to={`/functions/${f.id}`} className="text-blue-700 hover:underline">{f.name}</Link>, f.runtime, `${f.memory} MB`, f.status, f.minInstances, f.lastInvokedAt ? whenUtc(f.lastInvokedAt) : 'never'])}
          />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Databases</h2>
        {view.databases.length === 0 ? (
          <EmptyState>No database.</EmptyState>
        ) : (
          <Table
            head={['Name', 'On the server', 'Status', 'Size', 'Sessions', 'Plan storage', 'Created']}
            rows={view.databases.map((d) => [
              d.name,
              <span className="font-mono text-xs">{d.database}</span>,
              d.status.replace('_', '-'),
              formatMegabytes(d.sizeBytes),
              d.connections ?? '–',
              `${d.storageLimitMb.toLocaleString('en-US')} MB`,
              whenUtc(d.createdAt),
            ])}
          />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Buckets</h2>
        <p className="text-sm text-slate-600">Together: {bucketStorageLabel(account)}.</p>
        {view.buckets.length === 0 ? (
          <EmptyState>No bucket.</EmptyState>
        ) : (
          <Table
            head={['Name', 'In the store', 'Status', 'Size', 'Objects', 'Measured', 'Created']}
            rows={view.buckets.map((b) => [
              b.name,
              <span className="font-mono text-xs">{b.storeName}</span>,
              b.status,
              formatMegabytes(b.sizeBytes),
              b.objects === null ? '–' : b.objects.toLocaleString('en-US'),
              b.measuredAt ? whenUtc(b.measuredAt) : 'not yet',
              whenUtc(b.createdAt),
            ])}
          />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Usage in {view.usage.month} (UTC)</h2>
        <dl className="card grid gap-3 sm:grid-cols-3">
          {[
            ['Requests billed', totals.requests.toLocaleString('en')],
            ['Billed duration', `${totals.billedMs.toLocaleString('en')} ms`],
            ['GB-seconds', totals.gbSeconds],
            ['Throttled', totals.throttled],
            ['Platform errors', totals.platformErrors],
            ['Lost', totals.lost],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-gray-600">{label}</dt>
              <dd className="m-0 text-lg font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">Credit</h2>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setNotice(null);
              setGranting(true);
            }}
          >
            Grant credit
          </button>
        </div>
        <dl className="card space-y-3">
          <Fact label={balanceNote(credit.balance)}>
            <span className="text-lg font-semibold">{formatMoney(credit.balance, credit.currency)}</span>
          </Fact>
          <Fact label="Invokes">{creditStateLabel(credit)}</Fact>
          <Fact label={`Charged in ${credit.month} (UTC)`}>{chargesLabel(credit)}</Fact>
          {otherWallets.map(({ currency, balance }) => (
            <Fact key={currency} label={`${balanceNote(balance)}, in ${currency}`}>
              {formatMoney(balance, currency)}
            </Fact>
          ))}
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Payments</h2>
        <AccountPayments key={changes} accountId={account.id} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Invoices</h2>
        <AccountInvoices key={changes} accountId={account.id} />
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Status history</h2>
        {view.statusHistory.length === 0 ? (
          <EmptyState>No status change recorded.</EmptyState>
        ) : (
          <Table
            head={['When', 'Status', 'By', 'Reason']}
            rows={view.statusHistory.map((event) => [whenUtc(event.at), <StatusBadge key="status" status={event.status} />, event.by, event.reason ?? ''])}
          />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Audit log</h2>
        <DataTable
          columns={AUDIT_COLUMNS}
          rows={audit?.rows ?? null}
          rowKey={(entry) => entry.id}
          error={auditFailure}
          empty="Nothing recorded yet."
          onQuery={() => undefined}
          page={pageNumber(auditPaging)}
          hasNext={Boolean(audit?.next)}
          onNext={() => audit?.next && setAuditPaging(nextPage(auditPaging, audit.next))}
          onPrevious={() => setAuditPaging(previousPage(auditPaging))}
        />
      </section>

      {granting && (
        <GrantDialog
          accountName={account.name}
          currency={credit.currency}
          balance={credit.balance}
          threshold={credit.largeCreditThreshold}
          onGrant={grant}
          onCancel={() => setGranting(false)}
        />
      )}
      {pending && dialog && (
        <ReasonDialog title={dialog.title} confirmLabel={dialog.confirmLabel} onConfirm={confirm} onCancel={() => setPending(null)}>
          {dialog.body}
        </ReasonDialog>
      )}
    </div>
  );
};

export default Account;
