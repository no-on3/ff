// Shared by the front doors' tests (not part of the build: tsconfig.build.json excludes test-fixtures.ts).
import { KeyUses, NotedUse } from './key-uses.service';

/** KeyUses as a test sees it: each use the front door noted, in order, written nowhere. */
export function notedUses(): KeyUses & { seen: NotedUse[] } {
  const seen: NotedUse[] = [];
  return { seen, note: (use: NotedUse) => void seen.push(use) } as unknown as KeyUses & { seen: NotedUse[] };
}

/** A noted use as one line: the key, the service, the resource ('(the account)' for none) and the operation. */
export const useLine = ({ key, service, resource, operation }: NotedUse): string => `${key.id} ${service} ${resource || '(the account)'} ${operation}`;
