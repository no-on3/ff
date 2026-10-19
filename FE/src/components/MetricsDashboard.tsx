import React, { useCallback, useEffect, useState } from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, TooltipProps, XAxis, YAxis } from 'recharts';
import { apiErrorMessage } from '../lib/functions';
import { METRIC_RANGES, MetricRange, MetricRow, metricRows, metricTotals, milliseconds, pointLabel, rangeQuery } from '../lib/metrics';
import { Metrics, metricsApi } from '../services/api';

/** The first three slots of the validated categorical palette, in their fixed order. */
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a'] as const;
const AXIS = { fontSize: 12, fill: '#52514e' };
/** An axis's values as they are, to two decimals: its unit is in the chart's title. */
const tick = (value: number) => value.toLocaleString('en', { maximumFractionDigits: 2 });
const REFRESH_MS = 60_000;

const Figure: React.FC<{ label: string; value: string; note?: string }> = ({ label, value, note }) => (
  <div className="card py-3">
    <div className="text-sm text-gray-600">{label}</div>
    <div className="text-2xl font-semibold text-gray-900">{value}</div>
    {note && <div className="text-xs text-gray-500">{note}</div>}
  </div>
);

/** The tooltip: the period, then each series' value in ink, beside a mark of its colour. */
const ChartTooltip: React.FC<TooltipProps<number, string> & { period: number; unit?: (value: number) => string }> = ({ active, payload, label, period, unit }) =>
  active && label !== undefined ? (
    <div className="rounded border border-gray-200 bg-white px-3 py-2 text-sm shadow" role="status">
      <div className="mb-1 font-medium text-gray-900">{pointLabel(String(label), period)}</div>
      {payload?.length ? (
        payload.map((item) => (
          <div key={item.name} className="flex items-center gap-2 text-gray-700" data-series={item.name}>
            <span className="inline-block h-0.5 w-3" style={{ background: item.color }} aria-hidden="true" />
            <span>{item.name}</span>
            <span className="ml-auto pl-4 font-medium text-gray-900">{typeof item.value === 'number' ? (unit ? unit(item.value) : item.value.toLocaleString('en')) : '–'}</span>
          </div>
        ))
      ) : (
        <div className="text-gray-600">No call measured</div>
      )}
    </div>
  ) : null;

/**
 * A line needs two points: a measured period between two without a measure,
 * such as a minute's duration after a quiet hour, is drawn as a dot.
 */
const loneDot = (rows: MetricRow[], key: keyof MetricRow, color: string) =>
  function LoneDot({ cx, cy, index = 0 }: { cx?: number; cy?: number; index?: number }) {
    const alone = rows[index]?.[key] != null && rows[index - 1]?.[key] == null && rows[index + 1]?.[key] == null;
    return alone && cx !== undefined && cy !== undefined ? <circle key={index} cx={cx} cy={cy} r={4} fill={color} stroke="#fff" strokeWidth={2} /> : <g key={index} />;
  };

/** A chart of up to three series of one unit, on one axis: a crosshair and tooltip on hover, a legend for more than one. */
const Chart: React.FC<{
  title: string;
  rows: MetricRow[];
  period: number;
  series: ReadonlyArray<{ key: keyof MetricRow; name: string }>;
  unit?: (value: number) => string;
}> = ({ title, rows, period, series, unit }) => (
  <section className="card" aria-label={title}>
    <h3 className="mb-2 font-medium text-gray-900">{title}</h3>
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="#e7e6e2" vertical={false} />
        <XAxis dataKey="time" tickFormatter={(t: string) => pointLabel(t, period)} tick={AXIS} minTickGap={24} stroke="#c3c2b7" />
        <YAxis tick={AXIS} allowDecimals={!!unit} width={48} stroke="#c3c2b7" tickFormatter={tick} />
        <Tooltip content={<ChartTooltip period={period} unit={unit} />} cursor={{ stroke: '#8a8984', strokeWidth: 1 }} />
        {series.length > 1 && <Legend wrapperStyle={{ fontSize: 13 }} formatter={(value: string) => <span className="text-gray-700">{value}</span>} />}
        {series.map(({ key, name }, i) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            name={name}
            stroke={SERIES[i]}
            strokeWidth={2}
            dot={loneDot(rows, key, SERIES[i])}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  </section>
);

/**
 * A function's metrics, as CloudWatch names Lambda's: its calls, errors and
 * throttles, its durations' percentiles and its instances, a point per period
 * of the range, from the usage records the bill is made of. The figures are
 * also a table, for whoever can't tell the lines apart.
 */
export const MetricsDashboard: React.FC<{ functionId: string }> = ({ functionId }) => {
  const [range, setRange] = useState<MetricRange>('1h');
  const [view, setView] = useState<Metrics | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [asTable, setAsTable] = useState(false);

  const load = useCallback(async () => {
    try {
      setView((await metricsApi.forFunction(functionId, rangeQuery(range))).data);
      setFailure(null);
    } catch (error) {
      setFailure(apiErrorMessage(error));
    }
  }, [functionId, range]);

  useEffect(() => {
    setView(null);
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const rows = view ? metricRows(view) : [];
  const totals = view ? metricTotals(view) : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-gray-700">
          Time range
          <select aria-label="Time range" className="input mt-1 block" value={range} onChange={(e) => setRange(e.target.value as MetricRange)}>
            {METRIC_RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-secondary" onClick={() => setAsTable((v) => !v)}>
          {asTable ? 'Show the charts' : 'Show as a table'}
        </button>
        <p className="pb-2 text-sm text-gray-500">From the usage records the bill is made of; refreshed every minute.</p>
      </div>
      {failure && <div className="rounded border border-red-400 bg-red-100 px-4 py-3 text-red-700">{failure}</div>}
      {!view && !failure && <p className="text-gray-500">Loading…</p>}
      {view && totals && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <Figure label="Invocations" value={totals.invocations.toLocaleString('en')} />
            <Figure label="Errors" value={totals.errors.toLocaleString('en')} note={totals.errorRate === null ? undefined : `${totals.errorRate}% of the calls`} />
            <Figure label="Throttles" value={totals.throttles.toLocaleString('en')} note="Refused: no instance free, or the rate limit" />
            <Figure label="Cold starts" value={totals.coldStarts.toLocaleString('en')} />
            <Figure label="Slowest call" value={milliseconds(totals.slowest)} />
            <Figure label="Most instances" value={String(totals.peakInstances)} />
          </div>
          {totals.invocations === 0 && totals.throttles === 0 && <p className="text-gray-600">No call in this range.</p>}
          {asTable ? (
            <div className="card overflow-x-auto p-0">
              <table className="w-full text-left text-sm" aria-label="Metrics per period">
                <thead className="bg-gray-50 text-gray-600">
                  <tr>
                    {['Period', 'Invocations', 'Errors', 'Throttles', 'Cold starts', 'p50', 'p95', 'p99', 'Instances'].map((label) => (
                      <th key={label} className="px-3 py-2 font-medium">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.time} className="border-t border-gray-200">
                      <td className="whitespace-nowrap px-3 py-1">{pointLabel(row.time, view.period)}</td>
                      <td className="px-3 py-1">{row.Invocations}</td>
                      <td className="px-3 py-1">{row.Errors}</td>
                      <td className="px-3 py-1">{row.Throttles}</td>
                      <td className="px-3 py-1">{row.ColdStarts}</td>
                      <td className="px-3 py-1">{milliseconds(row.p50)}</td>
                      <td className="px-3 py-1">{milliseconds(row.p95)}</td>
                      <td className="px-3 py-1">{milliseconds(row.p99)}</td>
                      <td className="px-3 py-1">{row.Instances}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <Chart
                title="Calls"
                rows={rows}
                period={view.period}
                series={[
                  { key: 'Invocations', name: 'Invocations' },
                  { key: 'Errors', name: 'Errors' },
                  { key: 'Throttles', name: 'Throttles' },
                ]}
              />
              <Chart
                title="Duration (ms)"
                rows={rows}
                period={view.period}
                unit={milliseconds}
                series={[
                  { key: 'p50', name: 'p50' },
                  { key: 'p95', name: 'p95' },
                  { key: 'p99', name: 'p99' },
                ]}
              />
              <Chart title="Most instances ready" rows={rows} period={view.period} series={[{ key: 'Instances', name: 'Instances' }]} />
            </div>
          )}
        </>
      )}
    </div>
  );
};
