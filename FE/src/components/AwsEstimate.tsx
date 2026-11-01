import React, { useEffect, useState } from 'react';
import { apiErrorMessage } from '../lib/functions';
import { awsEstimateTable, awsPricesNote, toggleLine } from '../lib/usage';
import { AwsEstimate as Estimate, AwsExtraLine, usageApi } from '../services/api';

/**
 * The last three months at AWS's prices, an estimate: what FF counted, at AWS's US$ list prices with AWS's free tier,
 * then what AWS bills that FF doesn't, each line with what it assumes and a box that leaves it out of the totals.
 */
const AwsEstimate: React.FC<{ accountId: string }> = ({ accountId }) => {
  const [without, setWithout] = useState<AwsExtraLine[]>([]);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let current = true; // an answer for the lines chosen before is dropped
    setLoading(true);
    setError(null);
    usageApi
      .getAwsEstimate(without)
      .then(({ data }) => current && setEstimate(data))
      .catch((failure) => current && setError(apiErrorMessage(failure)))
      .finally(() => current && setLoading(false));
    return () => {
      current = false;
    };
  }, [without, accountId]);

  const table = estimate && awsEstimateTable(estimate);
  const assumed = estimate?.months[0]?.lines.filter((line) => line.assumption !== null) ?? [];
  return (
    <section aria-label="At AWS's prices" className="card mb-4 mt-8">
      <h2 className="text-lg font-semibold mb-1">At AWS's prices, an estimate</h2>
      <p className="text-sm text-gray-600 mb-3">
        The last three months as they would have cost on AWS: what FF counted, then what AWS bills that FF doesn't, each line with what it assumes.
        Untick a line to leave it out of the totals.
      </p>

      {error && (
        <div role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-red-900">
          {error}
        </div>
      )}

      {table === null ? (
        !error && <p>Loading…</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="data-table" aria-busy={loading}>
              <thead className="text-gray-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">In US$</th>
                  {table.months.map((month) => (
                    <th key={month} className="py-2 pr-4 font-medium text-right whitespace-nowrap">
                      {month}
                    </th>
                  ))}
                  <th className="py-2 font-medium">Counted</th>
                </tr>
              </thead>
              <tbody>
                {table.rows.map(({ key, label, extra, leftOut, total, cells }) => (
                  <tr key={key} data-line={key} className={`border-t border-gray-200 ${total ? 'font-semibold' : ''} ${leftOut ? 'text-gray-500' : ''}`}>
                    <td className="py-2 pr-4">
                      {label}
                      {leftOut && <span className="font-normal"> (left out)</span>}
                    </td>
                    {cells.map((cell, index) => (
                      <td key={table.months[index]} className={`py-2 pr-4 text-right whitespace-nowrap ${leftOut ? 'line-through' : ''}`}>
                        {cell}
                      </td>
                    ))}
                    <td className="py-2">
                      {extra && (
                        <input
                          type="checkbox"
                          aria-label={`Count ${label}`}
                          checked={!without.includes(extra)}
                          disabled={loading}
                          onChange={() => setWithout((lines) => toggleLine(lines, extra))}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {assumed.length > 0 && (
            <dl className="mt-4 space-y-1 text-sm text-gray-600" aria-label="What each line assumes">
              {assumed.map((line) => (
                <div key={line.line}>
                  <dt className="inline font-medium text-gray-700">{line.label}: </dt>
                  <dd className="inline m-0">{line.assumption}</dd>
                </div>
              ))}
            </dl>
          )}
          {estimate && <p className="text-xs text-gray-500 mt-3">{awsPricesNote(estimate)}</p>}
        </>
      )}
    </section>
  );
};

export default AwsEstimate;
