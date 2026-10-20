// The operator's metrics as tests read them (not part of the build: tsconfig.build.json excludes test-fixtures.ts).
import { Metric } from 'prom-client';

/**
 * A metric's value now, for these labels; a histogram's `count` or `sum`
 * series. 0 before anything was counted. The registry lives as long as the
 * process, so a test compares the value before and after what it does.
 */
export async function valueOf(metric: Metric, labels: Record<string, string> = {}, series?: 'count' | 'sum'): Promise<number> {
  const { name, values } = (await metric.get()) as { name: string; values: Array<{ value: number; labels: Record<string, unknown>; metricName?: string }> };
  const wanted = series ? `${name}_${series}` : undefined;
  const found = values.find(
    (value) => (wanted ? value.metricName === wanted : !value.metricName || value.metricName === name) && Object.entries(labels).every(([key, label]) => value.labels[key] === label),
  );
  return found?.value ?? 0;
}
