import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { accountsApi, plansApi } from '../api';
import DataTable, { Column, Filter } from '../components/DataTable';
import { ErrorState } from '../components/States';
import StatusBadge from '../components/StatusBadge';
import { ACCOUNT_STATUSES, AccountSummary, PlanOption, ownersOf } from '../lib/accounts';
import { apiErrorMessage, notAnOperator } from '../lib/errors';
import { TableQuery, currentCursor, firstPage, nextPage, pageNumber, pageParams, previousPage } from '../lib/table';
import { whenUtc } from '../lib/time';

const COLUMNS: Array<Column<AccountSummary>> = [
  {
    label: 'Account',
    cell: (account) => (
      <Link to={`/accounts/${account.id}`} className="font-medium text-blue-700 hover:underline">
        {account.name}
        <span className="block font-mono text-xs font-normal text-gray-500">{account.id}</span>
      </Link>
    ),
  },
  { label: 'Status', cell: (account) => <StatusBadge status={account.status} /> },
  { label: 'Owners', cell: ownersOf },
  { label: 'What they plan to build', cell: (account) => account.useCase ?? '' },
  { label: 'Plan', cell: (account) => account.planId },
  { label: 'Created', cell: (account) => whenUtc(account.createdAt), className: 'whitespace-nowrap' },
];

/**
 * Every account (P-71), newest first, searched and filtered. With
 * ?status=pending, as the sign-up e-mails link to it, it is the approvals
 * queue: each account opens on its page, where it is approved or rejected.
 */
const Accounts: React.FC<{ email: string | undefined; status: string }> = ({ email, status }) => {
  const pending = status === 'pending';
  const [query, setQuery] = useState<TableQuery>({ search: '', filters: { status } });
  const [paging, setPaging] = useState(firstPage());
  const [page, setPage] = useState<{ rows: AccountSummary[]; next: string | null } | null>(null);
  const [plans, setPlans] = useState<PlanOption[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);

  const load = useCallback(async (current: TableQuery, before: string | null) => {
    setPage(null);
    setFailure(null);
    try {
      const { data } = await accountsApi.page(pageParams(current, before));
      setPage({ rows: data.accounts, next: data.next });
    } catch (error) {
      if (notAnOperator(error)) setRefused(true);
      else setFailure(apiErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load(query, currentCursor(paging));
  }, [load, query, paging]);
  useEffect(() => {
    plansApi.list().then(({ data }) => setPlans(data), () => undefined); // the plan filter waits for them; the list doesn't
  }, []);

  if (refused) return <ErrorState message={`You are logged in as ${email ?? 'someone'}, who isn't one of FF's operators.`} />;

  const filters: Filter[] = [
    { name: 'status', label: 'Status', options: ACCOUNT_STATUSES },
    { name: 'plan', label: 'Plan', options: plans.map((plan) => ({ value: plan.id, label: plan.name })) },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{pending ? 'Approvals' : 'Accounts'}</h1>
        <p className="text-gray-600">
          {pending
            ? 'New accounts waiting for your approval, newest first. Open one to approve or reject it, with a reason.'
            : 'Every account, newest first. Open one for its members, functions, usage and history.'}
        </p>
      </div>
      <DataTable
        columns={COLUMNS}
        rows={page?.rows ?? null}
        rowKey={(account) => account.id}
        error={failure}
        empty={pending ? 'No account is waiting for approval.' : 'No account matches.'}
        search="ID, name or e-mail"
        filters={filters}
        initial={{ status }}
        onQuery={(next) => {
          setQuery(next);
          setPaging(firstPage());
        }}
        page={pageNumber(paging)}
        hasNext={Boolean(page?.next)}
        onNext={() => page?.next && setPaging(nextPage(paging, page.next))}
        onPrevious={() => setPaging(previousPage(paging))}
      />
    </div>
  );
};

export default Accounts;
