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
