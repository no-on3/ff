import React, { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Link } from 'react-router-dom';
import { RootState } from '../store/store';
import { fetchFunctions, deleteFunction } from '../store/functionSlice';
import { NO_FILTER, RUNTIME_LABELS, STATUS_INFO, countText, filterFunctions, relativeTime, sparklinePoints, type FunctionFilter } from '../lib/function-list';
import { formatBytes } from '../lib/functions';
import { metricTotals, rangeQuery, type MetricTotals } from '../lib/metrics';
import { can } from '../lib/session';
import { formatMoney, usageMonths } from '../lib/usage';
import { metricsApi, usageApi, type FunctionStatus, type Runtime, type UsageEstimate } from '../services/api';
import { useSession } from '../session/session';
import { AppDispatch } from '../store/store';
import Icon from './Icon';
import { KeyNumber, KeyNumbers } from './KeyNumbers';
import { Page, PageHeader } from './Page';
import StatusPill from './StatusPill';

/** The account's last 24 hours, for the key numbers; null until read, or when they can't be. */
interface Day {
  totals: MetricTotals;
  invocations: number[];
}

/** The account's calls and errors of the last 24 hours, and this month's estimate, read once with the page. */
function useAccountNumbers(): { day: Day | null | 'failed'; estimate: UsageEstimate | null | 'none' | 'failed' } {
  const [day, setDay] = useState<Day | null | 'failed'>(null);
  const [estimate, setEstimate] = useState<UsageEstimate | null | 'none' | 'failed'>(null);
  useEffect(() => {
    let current = true;
    metricsApi
      .forAccount(rangeQuery('24h'))
      .then(({ data }) => current && setDay({ totals: metricTotals(data), invocations: data.metrics.Invocations }))
      .catch(() => current && setDay('failed'));
    usageApi
      .getMonth(usageMonths(new Date()).thisMonth)
      .then(({ data }) => current && setEstimate(data.estimate ?? 'none'))
      .catch(() => current && setEstimate('failed'));
    return () => {
      current = false;
    };
  }, []);
  return { day, estimate };
}

const Sparkline: React.FC<{ values: number[] }> = ({ values }) => (
  <svg width="104" height="20" viewBox="0 0 104 20" fill="none" aria-hidden="true" className="shrink-0 text-blue-500">
    <polyline points={sparklinePoints(values, 104, 18)} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" transform="translate(0 1)" />
  </svg>
);

const RUNTIMES = Object.entries(RUNTIME_LABELS) as Array<[Runtime, string]>;
const STATUSES = (['ACTIVE', 'CREATING', 'ERROR'] as const).map((status): [FunctionStatus, string] => [status, STATUS_INFO[status].label]);

/** The account's functions (W-03): its key numbers, then the functions in a table, searched and filtered. */
const FunctionList: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { functions, loading, error } = useSelector((state: RootState) => state.functions);
  const account = useSession().account!; // shown only for an account
  const mayChange = can(account.role, 'change functions');
  const { day, estimate } = useAccountNumbers();
  const [filter, setFilter] = useState<FunctionFilter>(NO_FILTER);
  const shown = useMemo(() => filterFunctions(functions, filter), [functions, filter]);
  const now = new Date();

  useEffect(() => {
    dispatch(fetchFunctions());
  }, [dispatch]);

  const handleDelete = (id: string, name: string) => {
    if (window.confirm(`Delete ${name}? This can't be undone.`)) {
      dispatch(deleteFunction(id));
    }
  };

  const totals = day && day !== 'failed' ? day.totals : null;
  const limit = account.plan.limits.functions;

  return (
    <Page>
      <PageHeader
        title="Functions"
        description="Each function runs your code when it is called: through the API, its URL or a schedule."
        actions={
          mayChange && (
            <Link to="/functions/new" className="btn btn-primary">
              <Icon name="plus" />
              Create function
            </Link>
          )
        }
      />

      <KeyNumbers label="Key numbers" className="mb-5 grid-cols-2 lg:grid-cols-4">
        <KeyNumber
          label="Calls, last 24 hours"
          value={totals ? totals.invocations.toLocaleString('en-US') : day === 'failed' ? '–' : '…'}
          note={
            totals && day !== 'failed' && day !== null ? (
              <>
                <span>{totals.throttles > 0 ? `${totals.throttles.toLocaleString('en-US')} throttled` : 'None throttled'}</span>
                <Sparkline values={day.invocations} />
              </>
            ) : (
              day === 'failed' && "Couldn't read the metrics"
            )
          }
        />
        <KeyNumber
          label="Errors, last 24 hours"
          value={totals ? (totals.errorRate === null ? '–' : `${totals.errorRate}%`) : day === 'failed' ? '–' : '…'}
          note={totals && (totals.invocations === 0 ? 'No calls' : `${totals.errors.toLocaleString('en-US')} failed calls`)}
        />
        <KeyNumber
          label="This month"
          value={typeof estimate === 'object' && estimate !== null ? formatMoney(estimate.total, estimate.currency) : estimate === null ? '…' : '–'}
          note={
            estimate === 'none' ? (
              'No prices for this month'
            ) : (
              <Link to="/usage" className="font-medium text-gray-600 hover:text-ink">
                Estimated so far, after the free tier
              </Link>
            )
          }
        />
        <KeyNumber
          label="Functions"
          value={
            <>
              {functions.length}
              <span className="text-base font-medium text-gray-500"> of {limit}</span>
            </>
          }
          note={`${account.plan.name} plan`}
        />
      </KeyNumbers>

      <section aria-label="Functions" className="overflow-hidden rounded-lg border border-line bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-3">
          <label className="relative w-full sm:w-72">
            <span className="sr-only">Search functions by name</span>
            <Icon name="search" className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              value={filter.query}
              onChange={(event) => setFilter({ ...filter, query: event.target.value })}
              placeholder="Search by name"
              className="input pl-9"
            />
          </label>
          <select
            aria-label="Runtime"
            value={filter.runtime}
            onChange={(event) => setFilter({ ...filter, runtime: event.target.value as FunctionFilter['runtime'] })}
            className="select"
          >
            <option value="all">All runtimes</option>
            {RUNTIMES.map(([runtime, label]) => (
              <option key={runtime} value={runtime}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="Status"
            value={filter.status}
            onChange={(event) => setFilter({ ...filter, status: event.target.value as FunctionFilter['status'] })}
            className="select"
          >
            <option value="all">All statuses</option>
            {STATUSES.map(([status, label]) => (
              <option key={status} value={status}>
                {label}
              </option>
            ))}
          </select>
          {!loading && !error && functions.length > 0 && (
            <span className="ml-auto text-xs text-gray-500" aria-live="polite">
              {countText(shown.length, functions.length)}
            </span>
          )}
        </div>

        {loading ? (
          <p className="px-4 py-10 text-center text-gray-500">Loading…</p>
        ) : error ? (
          <p role="alert" className="px-4 py-10 text-center text-red-700">
            {error}
          </p>
        ) : functions.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <div className="mx-auto mb-3 grid size-10 place-items-center rounded-lg bg-blue-50 text-blue-600">
              <Icon name="functions" size={20} />
            </div>
            <h2 className="text-base font-semibold text-ink">No functions yet</h2>
            <p className="mx-auto mt-1 max-w-md text-gray-600">
              {mayChange ? 'Create one here, or from your terminal with ' : 'Your account has none yet. Developers create them here, or from a terminal with '}
              <code className="font-mono text-[13px]">ff init</code> and <code className="font-mono text-[13px]">ff deploy</code>.
            </p>
            {mayChange && (
              <Link to="/functions/new" className="btn btn-primary mt-4">
                <Icon name="plus" />
                Create function
              </Link>
            )}
          </div>
        ) : shown.length === 0 ? (
          <div className="px-6 py-10 text-center text-gray-600">
            <p>No function matches.</p>
            <button type="button" className="btn btn-secondary mt-3" onClick={() => setFilter(NO_FILTER)}>
              Clear the search and filters
            </button>
          </div>
        ) : (
          // Positioned, so that the hidden "Actions" heading scrolls with the table instead of widening the page.
          <div className="relative overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-gray-50/70 text-xs text-gray-500">
                <tr className="border-b border-line">
                  <th scope="col" className="px-3.5 py-2.5 font-medium">Name</th>
                  <th scope="col" className="px-3.5 py-2.5 font-medium">Runtime</th>
                  <th scope="col" className="px-3.5 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-3.5 py-2.5 text-right font-medium">Memory</th>
                  <th scope="col" className="hidden px-3.5 py-2.5 text-right font-medium md:table-cell">Timeout</th>
                  <th scope="col" className="hidden px-3.5 py-2.5 font-medium lg:table-cell">Code</th>
                  <th scope="col" className="hidden px-3.5 py-2.5 font-medium md:table-cell">Last change</th>
                  {mayChange && (
                    <th scope="col" className="px-3.5 py-2.5">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {shown.map((fn) => {
                  const status = STATUS_INFO[fn.status];
                  return (
                    <tr key={fn.id} className="hover:bg-gray-50/70">
                      <td className="px-3.5 py-3">
                        <Link to={`/functions/${fn.id}`} className="font-semibold text-ink hover:text-blue-600">
                          {fn.name}
                        </Link>
                        <div className="font-mono text-xs text-gray-500">{fn.handler}</div>
                      </td>
                      <td className="px-3.5 py-3 whitespace-nowrap">{RUNTIME_LABELS[fn.runtime]}</td>
                      <td className="px-3.5 py-3">
                        <StatusPill tone={status.tone} label={status.label} title={fn.error ?? undefined} />
                      </td>
                      <td className="px-3.5 py-3 text-right whitespace-nowrap tabular-nums">{fn.memory} MB</td>
                      <td className="hidden px-3.5 py-3 text-right whitespace-nowrap tabular-nums md:table-cell">{fn.timeout} s</td>
                      <td className="hidden px-3.5 py-3 whitespace-nowrap text-gray-600 lg:table-cell">
                        {fn.packageType === 'zip' ? `Package, ${formatBytes(fn.codeSize)}` : 'Inline code'}
                      </td>
                      <td className="hidden px-3.5 py-3 whitespace-nowrap text-gray-600 md:table-cell" title={new Date(fn.updatedAt).toLocaleString()}>
                        {relativeTime(fn.updatedAt, now)}
                      </td>
                      {mayChange && (
                        <td className="px-3.5 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => handleDelete(fn.id, fn.name)}
                            aria-label={`Delete ${fn.name}`}
                            className="rounded-md px-2 py-1 text-[13px] font-medium text-gray-500 hover:bg-red-50 hover:text-red-700"
                          >
                            Delete
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Page>
  );
};

export default FunctionList;
