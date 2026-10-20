// Usage records for tests (not part of the build: tsconfig.build.json excludes test-fixtures.ts).
import { UsageRecord } from './usage-record.entity';
import { UsageService } from './usage.service';

/** A UsageService that keeps the records it is given, for services that only write them. */
export function recordingUsage(): { usage: UsageService; records: UsageRecord[] } {
  const records: UsageRecord[] = [];
  const usage = { record: async (record: UsageRecord) => void records.push(record) } as unknown as UsageService;
  return { usage, records };
}
