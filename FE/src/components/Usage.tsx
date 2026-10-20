import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiErrorMessage } from '../lib/functions';
import { estimateLines, formatBilledDuration, formatGbSeconds, formatMoney, monthLabel, notBilled, pricedFromNote, usageCsvName, usageMonths } from '../lib/usage';
import { MonthlyUsage, usageApi } from '../services/api';
import { useSession } from '../session/session';
import { saveFile } from '../lib/download';

const Figure: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="card">
    <div className="text-sm text-gray-500">{label}</div>
    <div className="text-2xl font-semibold mt-1">{value}</div>
  </div>
);

/** The account's usage, this month or last, per function (P-22), with its estimated cost (P-30): every member reads it. */
const Usage: React.FC = () => {
  const { account } = useSession();
  const months = useMemo(() => usageMonths(new Date()), []);
  const [month, setMonth] = useState(months.thisMonth);
  const [usage, setUsage] = useState<MonthlyUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const accountId = account?.id;

  useEffect(() => {
    let current = true; // a slow answer for the month left behind is dropped
    setUsage(null);
    setError(null);
    usageApi
      .getMonth(month)
      .then(({ data }) => current && setUsage(data))
      .catch((failure) => current && setError(apiErrorMessage(failure)));
    return () => {
      current = false;
    };
  }, [month, accountId]);

  if (!account) return null;

  const downloadCsv = async () => {
    setDownloading(true);
    setError(null);
    try {
      saveFile(usageCsvName(account.id, month), new Blob([(await usageApi.getMonthCsv(month)).data], { type: 'text/csv' }));
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setDownloading(false);
    }
  };

  const unbilled = usage ? notBilled(usage.totals) : [];
  return (
    <div className="container mx-auto px-4 py-8 max-w-5xl">
      <h1 className="text-2xl font-bold mb-2">Usage</h1>
      <p className="text-gray-600 mb-6">
        What your functions used, counted as it will be billed: requests, and GB-seconds (billed duration × memory). Costs are
        estimated at FF's prices, AWS Lambda's in TND, with the same free tier. Months follow the UTC calendar.
      </p>

      <div role="tablist" aria-label="Month" className="flex flex-wrap gap-2 mb-6">
        {[
          [months.thisMonth, 'This month'],
          [months.lastMonth, 'Last month'],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={month === value}
            className={`btn ${month === value ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setMonth(value)}
          >
            {label} ({monthLabel(value)})
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      {usage === null ? (
        !error && <p>Loading…</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-4">
            <Figure label="Requests billed" value={usage.totals.requests.toLocaleString('en-US')} />
            <Figure label="Billed duration" value={formatBilledDuration(usage.totals.billedMs)} />
            <Figure label="GB-seconds" value={formatGbSeconds(usage.totals.gbSeconds)} />
            <Figure label="Estimated cost" value={usage.estimate ? formatMoney(usage.estimate.total, usage.estimate.currency) : '–'} />
          </div>
          {unbilled.length > 0 && <p className="text-sm text-gray-600 mb-4">Not billed: {unbilled.join(', ')}.</p>}

          {usage.estimate ? (
            <div className="card mb-4" aria-label="Estimated cost">
              <dl className="space-y-1 text-sm max-w-md">
                {estimateLines(usage.estimate).map(([label, amount], index, lines) => (
                  <div key={label} className={`flex justify-between gap-4 ${index === lines.length - 1 ? 'border-t border-gray-200 pt-1 font-semibold' : ''}`}>
                    <dt>{label}</dt>
                    <dd className="m-0 whitespace-nowrap">{amount}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-gray-500 mt-3">
                Each function's cost is before the free tier, which comes off the month's total. Each amount is rounded to the
                millime on its own. {pricedFromNote(usage.month, usage.estimate)}
              </p>
            </div>
          ) : (
            <p className="text-sm text-gray-600 mb-4">No price applies to {monthLabel(usage.month)}.</p>
          )}

          <div className="card overflow-x-auto mb-4">
            {usage.functions.length === 0 ? (
              <p className="text-gray-500">No calls in {monthLabel(usage.month)}.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-gray-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Function</th>
                    <th className="py-2 pr-4 font-medium text-right">Requests billed</th>
                    <th className="py-2 pr-4 font-medium text-right">Billed duration</th>
                    <th className="py-2 pr-4 font-medium text-right">GB-seconds</th>
                    <th className="py-2 pr-4 font-medium text-right">Cost (estimated)</th>
                    <th className="py-2 font-medium">Not billed</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.functions.map((fn) => (
                    <tr key={fn.functionId} data-function-id={fn.functionId} className="border-t border-gray-200">
                      <td className="py-2 pr-4">
                        {fn.deleted ? (
                          <>
                            {fn.functionName} <span className="text-gray-500">(deleted)</span>
                          </>
                        ) : (
                          <Link to={`/functions/${fn.functionId}`} className="text-blue-700 hover:underline">
                            {fn.functionName}
                          </Link>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right">{fn.requests.toLocaleString('en-US')}</td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap">{formatBilledDuration(fn.billedMs)}</td>
                      <td className="py-2 pr-4 text-right">{formatGbSeconds(fn.gbSeconds)}</td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap">
                        {fn.cost !== null && usage.estimate ? formatMoney(fn.cost, usage.estimate.currency) : '–'}
                      </td>
                      <td className="py-2 text-gray-600">{notBilled(fn).join(', ') || '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <button type="button" className="btn btn-secondary" onClick={downloadCsv} disabled={downloading}>
            {downloading ? 'Preparing…' : `Download ${monthLabel(usage.month)} as CSV`}
          </button>
        </>
      )}
    </div>
  );
};

export default Usage;
