import { FunctionAlias } from './entities/function-alias.entity';

/** What Lambda calls the function as it is, its unpublished code and settings. */
export const LATEST = '$LATEST';

/**
 * A qualifier as Lambda's: $LATEST, a version by its number, or an alias by
 * its name, which is never digits alone (ALIAS_NAME). A version's number fits
 * the table's integer.
 */
export const QUALIFIER = /^(\$LATEST|[1-9][0-9]{0,8}|(?!\d+$)[A-Za-z0-9_-]{1,128})$/;

/** What a qualifier names: a version, an alias, or neither, for $LATEST. */
export type Named = { version: number } | { alias: string } | null;

/** What `qualifier` names, as QUALIFIER reads it: none, or $LATEST, is $LATEST. */
export function parseQualifier(qualifier: string | undefined): Named {
  if (qualifier === undefined || qualifier === LATEST) return null;
  return /^\d+$/.test(qualifier) ? { version: Number(qualifier) } : { alias: qualifier };
}

/**
 * The version a call through an alias runs, as Lambda routes it: its other
 * version for a share `additionalWeight` of the calls, else its own;
 * undefined for $LATEST. `random` is drawn from [0, 1), once for each call.
 */
export function drawVersion(alias: Pick<FunctionAlias, 'version' | 'additionalVersion' | 'additionalWeight'>, random = Math.random()): number | undefined {
  if (alias.additionalVersion !== null && alias.additionalWeight !== null && random < alias.additionalWeight) return alias.additionalVersion;
  return alias.version ?? undefined;
}

/** A version by its number, or $LATEST: what ran a call, as CloudWatch's ExecutedVersion dimension names it. */
export const EXECUTED_VERSION = /^(\$LATEST|[1-9][0-9]{0,8})$/;

/**
 * Which of a function's calls a view keeps, as CloudWatch picks Lambda's by
 * their dimensions: `resource`, what a call named (an alias, a version, or
 * $LATEST for a call that named neither), and `executedVersion`, what ran it,
 * through an alias or not. Either left out keeps every call.
 */
export interface CallFilter {
  resource?: string;
  executedVersion?: string;
}

/** What the records of the calls a filter keeps hold: a version, null for $LATEST, and an alias, null for none; a field left out holds anything. */
export interface KeptCalls {
  version?: number | null;
  alias?: string | null;
}

/** The records' fields of the calls `filter` keeps; undefined when no call can be both what it names and what it ran. */
export function callsKept(filter: CallFilter): KeptCalls | undefined {
  const kept: KeptCalls = {};
  if (filter.resource !== undefined) {
    const named = parseQualifier(filter.resource);
    if (named && 'alias' in named) kept.alias = named.alias;
    else {
      // A version named, or $LATEST, is a call that came through no alias.
      kept.version = named?.version ?? null;
      kept.alias = null;
    }
  }
  if (filter.executedVersion !== undefined) {
    const ran = parseQualifier(filter.executedVersion);
    const version = ran && 'version' in ran ? ran.version : null;
    if (kept.version !== undefined && kept.version !== version) return undefined;
    kept.version = version;
  }
  return kept;
}

/** Whether a filter leaves any call out. */
export function isFiltered(filter: CallFilter): boolean {
  return filter.resource !== undefined || filter.executedVersion !== undefined;
}
