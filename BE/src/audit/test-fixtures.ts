// The audit log for tests (not part of the build: tsconfig.build.json excludes test-fixtures.ts).
import { AuditEvent, AuditService } from './audit.service';

/** An AuditService that keeps the events it is given, for services that only record. */
export function recordingAudit(): { audit: AuditService; events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  const audit = { record: async (event: AuditEvent) => void events.push(event) } as unknown as AuditService;
  return { audit, events };
}
