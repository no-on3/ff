import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AccountAuditEntry, accountsApi, plansApi } from '../api';
import DataTable, { Column } from '../components/DataTable';
import ReasonDialog from '../components/ReasonDialog';
import { EmptyState, ErrorState, Loading } from '../components/States';
import StatusBadge from '../components/StatusBadge';
import { AccountView, PlanOption, STATUS_CHANGES, StatusChange, changedNotice, changesFor, isAccountId, ownersSee } from '../lib/accounts';
import { actionLabel, describeAction } from '../lib/audit';
import { apiErrorMessage, notAnOperator } from '../lib/errors';
import { balanceNote, formatMoney } from '../lib/money';
import { currentCursor, firstPage, nextPage, pageNumber, previousPage } from '../lib/table';
import { whenUtc } from '../lib/time';

/** The change waiting for its reason, in the dialog. */
type Pending = { kind: 'status'; change: StatusChange } | { kind: 'plan'; planId: string } | { kind: 'egress'; on: boolean };

const AUDIT_COLUMNS: Array<Column<AccountAuditEntry>> = [
  { label: 'When', cell: (entry) => whenUtc(entry.at), className: 'whitespace-nowrap' },
  { label: 'Who', cell: (entry) => entry.actorLabel },
  { label: 'Action', cell: (entry) => actionLabel(entry.action), className: 'whitespace-nowrap' },
  { label: 'What', cell: (entry) => describeAction(entry) },
  { label: 'Reason', cell: (entry) => (typeof entry.details?.reason === 'string' ? entry.details.reason : '') },
];

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="grid gap-1 sm:grid-cols-[14rem_1fr] sm:gap-6">
    <dt className="font-medium">{label}</dt>
    <dd className="m-0 break-words">{children}</dd>
  </div>
);

const Table: React.FC<{ head: string[]; rows: React.ReactNode[][] }> = ({ head, rows }) => (
  <div className="card overflow-x-auto p-0">
    <table className="w-full text-left text-sm">
      <thead className="bg-gray-50 text-gray-600">
        <tr>
          {head.map((label) => (
            <th key={label} className="px-4 py-2 font-medium">
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((cells, index) => (
          <tr key={index} className="border-t border-gray-200 align-top">
            {cells.map((cell, column) => (
              <td key={column} className="px-4 py-2">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);

/**
 * One account (P-71): what sign-up collected, its people, functions, this
 * month's usage and its history, and the operator's changes, each with a
 * reason that goes to the account's audit log.
 */
const Account: React.FC<{ email: string | undefined }> = ({ email }) => {
  const { id } = useParams();
  const [view, setView] = useState<AccountView | null>(null);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [planChoice, setPlanChoice] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
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
    return {
      title: `Turn internet egress ${pending.on ? 'on' : 'off'} for ${account.name}?`,
      body: (
        <p>
          Internet egress: {account.internetEgress ? 'on' : 'off'} → {pending.on ? 'on' : 'off'}. Recorded for the account; the cluster
          follows it once egress is set per account (P-62).
        </p>
      ),
      confirmLabel: pending.on ? 'Turn on' : 'Turn off',
    };
  })();
  const { totals } = view.usage;

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
            rows={view.functions.map((f) => [f.name, f.runtime, `${f.memory} MB`, f.status, f.minInstances, f.lastInvokedAt ? whenUtc(f.lastInvokedAt) : 'never'])}
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
        <h2 className="text-lg font-semibold">Balance</h2>
        {view.balances.length === 0 ? (
          <EmptyState>No credit or debit yet.</EmptyState>
        ) : (
          <dl className="card grid gap-3 sm:grid-cols-3">
            {view.balances.map(({ currency, balance }) => (
              <div key={currency}>
                <dt className="text-sm text-gray-600">{balanceNote(balance)}</dt>
                <dd className="m-0 text-lg font-semibold">{formatMoney(balance, currency)}</dd>
              </div>
            ))}
          </dl>
        )}
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

      {pending && dialog && (
        <ReasonDialog title={dialog.title} confirmLabel={dialog.confirmLabel} onConfirm={confirm} onCancel={() => setPending(null)}>
          {dialog.body}
        </ReasonDialog>
      )}
    </div>
  );
};

export default Account;
