import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { statsApi } from '../api';
import { Fact, Table } from '../components/Facts';
import { ErrorState, Loading } from '../components/States';
import { config } from '../config';
import { ACCOUNT_STATUSES } from '../lib/accounts';
import { apiErrorMessage, notAnOperator } from '../lib/errors';
import { formatMoney } from '../lib/money';
import { Overview as OverviewData, functionsLine, gbS, operatorDashboards, reservedOverBilled } from '../lib/overview';
import { whenUtc } from '../lib/time';

const count = (n: number) => n.toLocaleString('en-US');

/** The platform at a glance: accounts, functions and today's calls, this month's money, invoices, capacity, and the operator's dashboards. */
const Overview: React.FC<{ email: string | undefined }> = ({ email }) => {
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);

  const load = useCallback(() => {
    setFailure(null);
    statsApi
      .overview()
      .then(({ data }) => setOverview(data))
      .catch((error) => (notAnOperator(error) ? setRefused(true) : setFailure(apiErrorMessage(error))));
  }, []);
  useEffect(load, [load]);

  if (refused) return <ErrorState message={`You are logged in as ${email ?? 'someone'}, who isn't one of FF's operators.`} />;
  if (failure) return <ErrorState message={failure} />;
  if (!overview) return <Loading />;

  const { accounts, today, invoices } = overview;
  const dashboards = operatorDashboards('grafanaUrl' in config ? config.grafanaUrl : undefined);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Overview</h1>
          <p className="text-gray-600">The platform at a glance, as of {whenUtc(overview.computedAt)}: worked out at most once a minute.</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={load}>
          Refresh
        </button>
      </div>

      <section aria-label="Accounts" className="card space-y-3">
        <h2 className="text-lg font-semibold">Accounts</h2>
        <p>
          {accounts.pendingApprovals === 0 ? (
            'No account is waiting for your approval.'
          ) : (
            <Link to="/accounts?status=pending" className="font-medium text-blue-700 underline">
              {count(accounts.pendingApprovals)} waiting for your approval
            </Link>
          )}
        </p>
        <dl className="space-y-2">
          {ACCOUNT_STATUSES.map(({ value, label }) => (
            <Fact key={value} label={label}>
              <Link to={`/accounts?status=${value}`} className="text-blue-700 underline">
                {count(accounts.byStatus[value] ?? 0)}
              </Link>
            </Fact>
          ))}
        </dl>
      </section>

      <section aria-label="Functions and today's calls" className="card space-y-3">
        <h2 className="text-lg font-semibold">Functions, and today's calls</h2>
        <dl className="space-y-2">
          <Fact label="Functions">{functionsLine(overview.functions)}</Fact>
          <Fact label={`Calls on ${today.day} (UTC)`}>{count(today.invocations)}</Fact>
          <Fact label="Failed">{count(today.errors)}: errors, timeouts, the platform's failures and calls lost</Fact>
          <Fact label="Throttled">{count(today.throttles)}: refused by an instance limit or the rate limit</Fact>
        </dl>
      </section>

      {overview.money.map((money) => (
        <section key={money.currency} aria-label={`Money in ${money.currency}`} className="card space-y-3">
          <h2 className="text-lg font-semibold">
            Money in {overview.month} (UTC){overview.money.length > 1 ? `, in ${money.currency}` : ''}
          </h2>
          <dl className="space-y-2">
            <Fact label="Usage charged">
              {formatMoney(money.consumption.charged, money.currency)}: {formatMoney(money.consumption.debited, money.currency)} debited,{' '}
              {formatMoney(money.consumption.shadow, money.currency)} only rated in the billing trial
            </Fact>
            <Fact label="Credit bought">
              <Link to="/payments?status=paid" className="text-blue-700 underline">
                {count(money.topUps.payments)} transfer{money.topUps.payments === 1 ? '' : 's'}
              </Link>{' '}
              received: {formatMoney(money.topUps.credit, money.currency)} before tax
            </Fact>
            <Fact label="Credit FF owes">{formatMoney(money.balances.owedByFF, money.currency)}, unused in the wallets now</Fact>
            <Fact label="Owed to FF">
              {formatMoney(money.balances.owedToFF, money.currency)}
              {money.balances.walletsInDebt ? `, by ${count(money.balances.walletsInDebt)} account${money.balances.walletsInDebt === 1 ? '' : 's'} in debt` : ''}
            </Fact>
          </dl>
        </section>
      ))}

      <section aria-label="Invoices" className="card space-y-3">
        <h2 className="text-lg font-semibold">Invoices</h2>
        <dl className="space-y-2">
          <Fact label={`Issued in ${overview.month}`}>
            {count(invoices.issued)} invoice{invoices.issued === 1 ? '' : 's'}, {count(invoices.creditNotes)} credit note{invoices.creditNotes === 1 ? '' : 's'}
          </Fact>
          <Fact label={`${invoices.toIssue.month}'s to issue`}>
            {invoices.toIssue.drafts === 0 ? (
              'None'
            ) : (
              <Link to={`/invoices?month=${invoices.toIssue.month}`} className="text-blue-700 underline">
                {count(invoices.toIssue.drafts)} draft{invoices.toIssue.drafts === 1 ? '' : 's'}
              </Link>
            )}
            {invoices.toIssue.drafts > 0 && !invoices.toIssue.issuable ? ', once the month is over in Tunisia' : ''}
          </Fact>
        </dl>
      </section>

      <section aria-label="Capacity against billing" className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold">Capacity against billing, the last 7 days</h2>
          <p className="text-sm text-gray-600">
            What FF's servers held for every account (ready instances × memory) against what it billed: the gap is FF's cost. Days by the UTC calendar.
          </p>
        </div>
        <Table
          head={['Day', 'Held, GB-s', 'Provisioned, GB-s', 'Billed, GB-s', 'Calls billed', 'Held ÷ billed']}
          rows={overview.capacity.map((day) => [<span className="whitespace-nowrap">{day.day}</span>, gbS(day.reservedGbS), gbS(day.provisionedGbS), gbS(day.billedGbS), count(day.requests), reservedOverBilled(day)])}
        />
      </section>

      <section aria-label="Operator dashboards" className="card space-y-3">
        <h2 className="text-lg font-semibold">Operator dashboards</h2>
        {dashboards.length ? (
          <ul className="space-y-2">
            {dashboards.map((dashboard) => (
              <li key={dashboard.title}>
                <a href={dashboard.url} target="_blank" rel="noreferrer" className="font-medium text-blue-700 underline">
                  {dashboard.title}
                </a>
                <span className="text-gray-600">: {dashboard.about}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-gray-600">
            Grafana's address isn't set: build the dashboard with VITE_GRAFANA_URL (admin/.env.example). In development, hack/k8s/grafana.sh serves it at http://localhost:3001.
          </p>
        )}
      </section>
    </div>
  );
};

export default Overview;
