import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiErrorMessage } from '../lib/functions';
import { estimateLines, formatBilledDuration, formatGbMonths, formatGbSeconds, formatMoney, monthLabel, notBilled, pricedFromNote, usageCsvName, usageMonths } from '../lib/usage';
import { MonthlyUsage, usageApi } from '../services/api';
import { useSession } from '../session/session';
import { formatSize } from '../lib/databases';
import { KeyNumber, KeyNumbers } from './KeyNumbers';
import { saveFile } from '../lib/download';

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
    <div className="page max-w-5xl">
      <h1 className="mb-2">Usage</h1>
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
        <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-900">
          {error}
        </div>
      )}

      {usage === null ? (
        !error && <p>Loading…</p>
      ) : (
        <>
          <KeyNumbers label="The month's figures" className="mb-4 grid-cols-2 lg:grid-cols-4">
            <KeyNumber label="Requests billed" value={usage.totals.requests.toLocaleString('en-US')} />
            <KeyNumber label="Billed duration" value={formatBilledDuration(usage.totals.billedMs)} />
            <KeyNumber label="GB-seconds" value={formatGbSeconds(usage.totals.gbSeconds)} />
            <KeyNumber label="Estimated cost" value={usage.estimate ? formatMoney(usage.estimate.total, usage.estimate.currency) : '–'} />
          </KeyNumbers>
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
                Each function's and database's cost is before the free tier, which comes off the month's total. Each amount is rounded to
                the millime on its own. {pricedFromNote(usage.month, usage.estimate)}
              </p>
            </div>
          ) : (
            <p className="text-sm text-gray-600 mb-4">No price applies to {monthLabel(usage.month)}.</p>
          )}

          <div className="card overflow-x-auto mb-4">
            {usage.functions.length === 0 ? (
              <p className="text-gray-500">No calls in {monthLabel(usage.month)}.</p>
            ) : (
              <table className="data-table">
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

          {usage.databases.length > 0 && (
            <div className="card overflow-x-auto mb-4" aria-label="Databases">
              <table className="data-table">
                <thead className="text-gray-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Database</th>
                    <th className="py-2 pr-4 font-medium text-right">Hours measured</th>
                    <th className="py-2 pr-4 font-medium text-right">GB-months</th>
                    <th className="py-2 pr-4 font-medium text-right">Size, last measured</th>
                    <th className="py-2 font-medium text-right">Cost (estimated)</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.databases.map((database) => (
                    <tr key={database.databaseId} data-database-id={database.databaseId} className="border-t border-gray-200">
                      <td className="py-2 pr-4">
                        {database.deleted ? (
                          <>
                            {database.name} <span className="text-gray-500">(deleted)</span>
                          </>
                        ) : (
                          <Link to={`/databases/${database.databaseId}`} className="text-blue-700 hover:underline">
                            {database.name}
                          </Link>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right">{database.hours.toLocaleString('en-US')}</td>
                      <td className="py-2 pr-4 text-right">{formatGbMonths(database.gbMonths)}</td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap">{formatSize(database.sizeBytes)}</td>
                      <td className="py-2 text-right whitespace-nowrap">{database.cost !== null && usage.estimate ? formatMoney(database.cost, usage.estimate.currency) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-gray-500 mt-3">Storage is billed by the GB-month, as AWS RDS bills it: each database's size every hour, over the month's hours.</p>
            </div>
          )}

          {usage.buckets.length > 0 && (
            <div className="card overflow-x-auto mb-4" aria-label="Buckets">
              <table className="data-table">
                <thead className="text-gray-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Bucket</th>
                    <th className="py-2 pr-4 font-medium text-right">GB-months</th>
                    <th className="py-2 pr-4 font-medium text-right">Size, last measured</th>
                    <th className="py-2 pr-4 font-medium text-right">PUT, COPY, POST, LIST</th>
                    <th className="py-2 pr-4 font-medium text-right">GET and others</th>
                    <th className="py-2 pr-4 font-medium text-right">Sent out</th>
                    <th className="py-2 font-medium text-right">Cost (estimated)</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.buckets.map((bucket) => (
                    <tr key={bucket.bucketId} data-bucket-id={bucket.bucketId} className="border-t border-gray-200">
                      <td className="py-2 pr-4">
                        {bucket.deleted ? (
                          <>
                            {bucket.name} <span className="text-gray-500">(deleted)</span>
                          </>
                        ) : (
                          <Link to={`/buckets/${bucket.name}`} className="text-blue-700 hover:underline">
                            {bucket.name}
                          </Link>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right">{formatGbMonths(bucket.gbMonths)}</td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap">{bucket.hours > 0 ? formatSize(bucket.sizeBytes) : '–'}</td>
                      <td className="py-2 pr-4 text-right">{bucket.tier1Requests.toLocaleString('en-US')}</td>
                      <td className="py-2 pr-4 text-right">{bucket.tier2Requests.toLocaleString('en-US')}</td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap">{formatSize(bucket.bytesDownloaded)}</td>
                      <td className="py-2 text-right whitespace-nowrap">{bucket.cost !== null && usage.estimate ? formatMoney(bucket.cost, usage.estimate.currency) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-gray-500 mt-3">
                As AWS S3 bills Standard storage: what each bucket held every hour, by the GB-month, and its requests by S3's two classes; deleting is free. What
                each sent out is counted, not billed.
              </p>
            </div>
          )}

          {usage.queues.length > 0 && (
            <div className="card overflow-x-auto mb-4" aria-label="Queues">
              <table className="data-table">
                <thead className="text-gray-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Queue</th>
                    <th className="py-2 pr-4 font-medium text-right">Requests</th>
                    <th className="py-2 pr-4 font-medium text-right">Messages sent</th>
                    <th className="py-2 pr-4 font-medium text-right">Messages received</th>
                    <th className="py-2 font-medium text-right">Cost (estimated)</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.queues.map((queue) => (
                    <tr key={queue.queueId} data-queue-id={queue.queueId} className="border-t border-gray-200">
                      <td className="py-2 pr-4">
                        {queue.deleted ? (
                          <>
                            {queue.name} <span className="text-gray-500">(deleted)</span>
                          </>
                        ) : (
                          <Link to={`/queues/${queue.name}`} className="text-blue-700 hover:underline">
                            {queue.name}
                          </Link>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right">{queue.requests.toLocaleString('en-US')}</td>
                      <td className="py-2 pr-4 text-right">{queue.messagesSent.toLocaleString('en-US')}</td>
                      <td className="py-2 pr-4 text-right">{queue.messagesReceived.toLocaleString('en-US')}</td>
                      <td className="py-2 text-right whitespace-nowrap">{queue.cost !== null && usage.estimate ? formatMoney(queue.cost, usage.estimate.currency) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-gray-500 mt-3">
                As AWS SQS bills its requests: each 64 KB of the messages a request carries counts as one, and a function's batch as the request that would have
                received it. The first million each month are free.
              </p>
            </div>
          )}

          {usage.caches.length > 0 && (
            <div className="card overflow-x-auto mb-4" aria-label="Caches">
              <table className="data-table">
                <thead className="text-gray-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Cache</th>
                    <th className="py-2 pr-4 font-medium text-right">Memory</th>
                    <th className="py-2 pr-4 font-medium text-right">Hours</th>
                    <th className="py-2 pr-4 font-medium text-right">GB-hours</th>
                    <th className="py-2 font-medium text-right">Cost (estimated)</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.caches.map((cache) => (
                    <tr key={cache.cacheId} data-cache-id={cache.cacheId} className="border-t border-gray-200">
                      <td className="py-2 pr-4">
                        {cache.deleted ? (
                          <>
                            {cache.name} <span className="text-gray-500">(deleted)</span>
                          </>
                        ) : (
                          <Link to="/caches" className="text-blue-700 hover:underline">
                            {cache.name}
                          </Link>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right">{cache.memoryMb.toLocaleString('en-US')} MB</td>
                      <td className="py-2 pr-4 text-right">{cache.hours.toLocaleString('en-US')}</td>
                      <td className="py-2 pr-4 text-right">{Number(cache.gbHours).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
                      <td className="py-2 text-right whitespace-nowrap">{cache.cost !== null && usage.estimate ? formatMoney(cache.cost, usage.estimate.currency) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-gray-500 mt-3">As AWS ElastiCache bills a node: its memory by the hour, whatever its keys use, measured once an hour.</p>
            </div>
          )}

          {usage.email.length > 0 && (
            <div className="card overflow-x-auto mb-4" aria-label="E-mail">
              <table className="data-table">
                <thead className="text-gray-500">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Sent from</th>
                    <th className="py-2 pr-4 font-medium text-right">Recipients</th>
                    <th className="py-2 pr-4 font-medium text-right">Attachments</th>
                    <th className="py-2 font-medium text-right">Cost (estimated)</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.email.map((identity) => (
                    <tr key={identity.resourceId} data-email-id={identity.resourceId} className="border-t border-gray-200">
                      <td className="py-2 pr-4">
                        {identity.deleted ? (
                          <>
                            {identity.identity} <span className="text-gray-500">(deleted)</span>
                          </>
                        ) : (
                          <Link to="/email" className="text-blue-700 hover:underline">
                            {identity.identity}
                          </Link>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right">{identity.recipients.toLocaleString('en-US')}</td>
                      <td className="py-2 pr-4 text-right">{identity.attachmentBytes > 0 ? formatSize(identity.attachmentBytes) : '–'}</td>
                      <td className="py-2 text-right whitespace-nowrap">{identity.cost !== null && usage.estimate ? formatMoney(identity.cost, usage.estimate.currency) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-xs text-gray-500 mt-3">As AWS SES bills it: each recipient of a message, a suppressed one too, and its attachments by the GB, each recipient's copy.</p>
            </div>
          )}

          <button type="button" className="btn btn-secondary" onClick={downloadCsv} disabled={downloading}>
            {downloading ? 'Preparing…' : `Download ${monthLabel(usage.month)} as CSV`}
          </button>
        </>
      )}
    </div>
  );
};

export default Usage;
