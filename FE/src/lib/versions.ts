/**
 * A function's versions and aliases, as the console shows and changes them:
 * the API's fields, which contract.test.ts ties to its views; where an
 * alias's calls go, in words; the alias form's own checks before sending (the
 * API checks again); the version a rollback points an alias back to; and what
 * a schedule or a queue reader may run.
 */

/** $LATEST, the function as it is: what an alias, a schedule or a queue reader runs when it names no version. */
export const LATEST = '$LATEST';

/** The fields of a version as the API answers them. */
export const VERSION_FIELDS = [
  'functionId',
  'functionArn',
  'version',
  'description',
  'runtime',
  'handler',
  'packageType',
  'codeSha256',
  'codeSize',
  'memory',
  'timeout',
  'eventFormat',
  'awsEndpoints',
  'revisionId',
  'createdAt',
  'environment',
] as const satisfies ReadonlyArray<keyof FunctionVersion>;

/** A version, as AWS Lambda's: the function as it was published, which never changes. */
export interface FunctionVersion {
  functionId: string;
  functionArn: string;
  /** Its number, as Lambda writes it: "1", "2", "3"… */
  version: string;
  description: string;
  runtime: string;
  handler: string;
  packageType: string;
  /** The SHA-256 of its code, in base64. */
  codeSha256: string;
  codeSize: number;
  memory: number;
  timeout: number;
  eventFormat: 'wrapped' | 'lambda';
  awsEndpoints: string[];
  revisionId: string;
  createdAt: string;
  /** Its variables as published, in a single version's answer alone. */
  environment?: Record<string, string>;
}

/** The fields of an alias as the API answers them. */
export const ALIAS_FIELDS = ['aliasArn', 'name', 'functionVersion', 'description', 'routingConfig', 'revisionId', 'createdAt', 'updatedAt'] as const satisfies ReadonlyArray<
  keyof FunctionAlias
>;

/** An alias, as AWS Lambda's: a name for a version, or $LATEST, and at most one more version with its share of the calls. */
export interface FunctionAlias {
  aliasArn: string;
  name: string;
  /** $LATEST, or the number of the version its calls go to. */
  functionVersion: string;
  description: string;
  /** Another version's share of its calls, from 0 to 1; absent when there is none. */
  routingConfig?: { additionalVersionWeights: Record<string, number> };
  revisionId: string;
  createdAt: string;
  updatedAt: string;
}

/** An alias's name, as Lambda's: letters, digits, - and _, not digits alone, which name a version; the API's rule. */
export const ALIAS_NAME = /^(?!\d+$)[A-Za-z0-9_-]{1,128}$/;

/** The other version an alias sends a share of its calls to, and that share from 0 to 1; undefined when it has none. */
export function shareOf(alias: Pick<FunctionAlias, 'routingConfig'>): { version: string; weight: number } | undefined {
  const [entry] = Object.entries(alias.routingConfig?.additionalVersionWeights ?? {});
  return entry ? { version: entry[0], weight: entry[1] } : undefined;
}

/** A share of the calls as a percentage, to a tenth: 0.1 is "10%", 0.125 "12.5%". */
export const percentText = (weight: number): string => `${Math.round(weight * 1000) / 10}%`;

/** Where an alias's calls go, in words: "Version 3", "$LATEST, the function as it is", "Version 3; 10% of its calls to version 4". */
export function routeText(alias: Pick<FunctionAlias, 'functionVersion' | 'routingConfig'>): string {
  const own = alias.functionVersion === LATEST ? '$LATEST, the function as it is' : `Version ${alias.functionVersion}`;
  const share = shareOf(alias);
  return share ? `${own}; ${percentText(share.weight)} of its calls to version ${share.version}` : own;
}

/**
 * The aliases whose calls go to a version, each with its part of them when it
 * shares them: "live" alone, or "live, 90%" for its own version and "live,
 * 10%" for the other.
 */
export function aliasesOn(version: string, aliases: Pick<FunctionAlias, 'name' | 'functionVersion' | 'routingConfig'>[]): Array<{ name: string; label: string }> {
  return aliases.flatMap((alias) => {
    const share = shareOf(alias);
    if (alias.functionVersion === version) return [{ name: alias.name, label: share ? `${alias.name}, ${percentText(1 - share.weight)}` : alias.name }];
    return share?.version === version ? [{ name: alias.name, label: `${alias.name}, ${percentText(share.weight)}` }] : [];
  });
}

/** The start of a code's SHA-256, enough to tell two versions' code apart at a glance. */
export const shortSha = (sha: string): string => (sha.length > 12 ? `${sha.slice(0, 12)}…` : sha);

/** The alias form's fields, as typed: the share as a percentage. */
export interface AliasForm {
  name: string;
  /** $LATEST or a version's number. */
  version: string;
  /** The other version that gets a share of the calls; empty for none. */
  shareVersion: string;
  sharePercent: string;
  description: string;
}

/** A new alias's form: the newest version, else $LATEST, and no share. */
export const emptyAliasForm = (versions: Pick<FunctionVersion, 'version'>[]): AliasForm => ({
  name: '',
  version: newestVersion(versions) ?? LATEST,
  shareVersion: '',
  sharePercent: '',
  description: '',
});

/** An alias's form, as it is. */
export function aliasFormOf(alias: FunctionAlias): AliasForm {
  const share = shareOf(alias);
  return {
    name: alias.name,
    version: alias.functionVersion,
    shareVersion: share?.version ?? '',
    sharePercent: share ? String(Math.round(share.weight * 1000) / 10) : '',
    description: alias.description,
  };
}

/**
 * The body of POST /functions/:id/aliases, or of PUT for a change, by Lambda's
 * names; or what is wrong in the form. A change sends no share as {} to clear
 * the one there; a new alias sends none.
 */
export function aliasBody(form: AliasForm, creating: boolean): { body: Record<string, unknown> } | { problem: string } {
  const name = form.name.trim();
  if (creating && !ALIAS_NAME.test(name)) return { problem: "The name has 1 to 128 letters, digits, '-' and '_', and isn't digits alone, which name a version" };
  let weights: Record<string, number> = {};
  if (form.shareVersion !== '') {
    if (form.version === LATEST) return { problem: 'A share of the calls goes beside a version: an alias naming $LATEST has none, as on Lambda' };
    if (form.shareVersion === form.version) return { problem: "The share goes to another version than the alias's own" };
    const percent = form.sharePercent.trim() === '' ? NaN : Number(form.sharePercent);
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return { problem: 'The share is a percentage of the calls, from 0 to 100' };
    weights = { [form.shareVersion]: percent / 100 };
  }
  const body: Record<string, unknown> = { functionVersion: form.version, description: form.description.trim() };
  if (creating) body.name = name;
  if (!creating || Object.keys(weights).length > 0) body.routingConfig = { additionalVersionWeights: weights };
  return { body };
}

/** Whether a qualifier names a version, by its number, rather than an alias, whose name is never digits alone. */
export const isVersionNumber = (qualifier: string): boolean => /^[1-9][0-9]*$/.test(qualifier);

/** What a schedule or a queue reader runs, when it names a version or an alias: "Runs version 3", "Runs alias live"; null for $LATEST, the function as it is. */
export function runsText(qualifier: string | null | undefined): string | null {
  if (!qualifier || qualifier === LATEST) return null;
  return isVersionNumber(qualifier) ? `Runs version ${qualifier}` : `Runs alias ${qualifier}`;
}

/** The newest of the versions, by number; undefined when there is none. */
export function newestVersion(versions: Pick<FunctionVersion, 'version'>[]): string | undefined {
  const numbers = versions.map((version) => Number(version.version));
  return numbers.length ? String(Math.max(...numbers)) : undefined;
}

/**
 * The version a rollback points the alias back to: the newest of the versions
 * before its own that are still there; undefined for an alias naming $LATEST,
 * or one with none before it.
 */
export function rollbackTarget(alias: Pick<FunctionAlias, 'functionVersion'>, versions: Pick<FunctionVersion, 'version'>[]): string | undefined {
  if (alias.functionVersion === LATEST) return undefined;
  return newestVersion(versions.filter((version) => Number(version.version) < Number(alias.functionVersion)));
}

/** A rollback's change, sent with the alias's revision, so that another change meanwhile is refused: every call to the version before, the share gone. */
export const rollbackBody = (alias: Pick<FunctionAlias, 'revisionId'>, target: string) => ({
  functionVersion: target,
  routingConfig: { additionalVersionWeights: {} },
  revisionId: alias.revisionId,
});

/**
 * What a schedule or a queue reader may run, for a form's choice: $LATEST
 * (the value ''), each alias with where it goes, each version, newest first.
 * One it names that is gone since is kept, so that the form shows it.
 */
export function qualifierChoices(
  versions: Pick<FunctionVersion, 'version'>[],
  aliases: Pick<FunctionAlias, 'name' | 'functionVersion' | 'routingConfig'>[],
  current = '',
): Array<{ value: string; label: string }> {
  const choices = [
    { value: '', label: '$LATEST, the function as it is' },
    ...[...aliases].sort((a, b) => a.name.localeCompare(b.name)).map((alias) => ({ value: alias.name, label: `Alias ${alias.name}: ${routeText(alias)}` })),
    ...[...versions].sort((a, b) => Number(b.version) - Number(a.version)).map((version) => ({ value: version.version, label: `Version ${version.version}` })),
  ];
  if (current !== '' && !choices.some((choice) => choice.value === current)) {
    choices.push({ value: current, label: `${isVersionNumber(current) ? 'Version' : 'Alias'} ${current}, deleted since` });
  }
  return choices;
}

/**
 * Some of a function's calls, as CloudWatch keeps Lambda's metrics by their
 * Resource and ExecutedVersion dimensions: by what they named (an alias, a
 * version, or $LATEST for those naming neither) and by what ran them (a
 * version, or $LATEST). '' for either keeps every call.
 */
export interface CallsPick {
  resource: string;
  executedVersion: string;
}

export const EVERY_CALL: CallsPick = { resource: '', executedVersion: '' };

/** A pick as a select's value, `resource|executedVersion`; `|` for every call. */
export const pickValue = (pick: CallsPick): string => `${pick.resource}|${pick.executedVersion}`;

/** The pick a select's value holds. */
export function pickOf(value: string): CallsPick {
  const [resource = '', executedVersion = ''] = value.split('|');
  return { resource, executedVersion };
}

/** A pick as the API's query: the dimensions it names, none for every call. */
export function pickQuery(pick: CallsPick): Partial<CallsPick> {
  return { ...(pick.resource ? { resource: pick.resource } : {}), ...(pick.executedVersion ? { executedVersion: pick.executedVersion } : {}) };
}

/** A pick in words: "calls through alias live", "calls naming version 3, run by version 3"; null for every call. */
export function callsText(pick: CallsPick): string | null {
  const parts: string[] = [];
  if (pick.resource === LATEST) parts.push('calls naming no alias or version');
  else if (pick.resource) parts.push(isVersionNumber(pick.resource) ? `calls naming version ${pick.resource}` : `calls through alias ${pick.resource}`);
  if (pick.executedVersion) parts.push(`${parts.length ? '' : 'calls '}run by ${pick.executedVersion === LATEST ? LATEST : `version ${pick.executedVersion}`}`);
  return parts.length ? parts.join(', ') : null;
}

/**
 * The calls a metrics view or an alarm may pick: every one; those through
 * each alias; those naming each version, newest first, or neither; those each
 * version ran, or $LATEST, however they were named. One picked whose alias or
 * version is gone since is kept, as its calls still are.
 */
export function callsChoices(
  versions: Pick<FunctionVersion, 'version'>[],
  aliases: Pick<FunctionAlias, 'name'>[],
  current: CallsPick = EVERY_CALL,
): Array<{ value: string; label: string }> {
  const newest = [...versions].sort((a, b) => Number(b.version) - Number(a.version));
  const choices = [
    { value: pickValue(EVERY_CALL), label: 'Every call' },
    ...[...aliases].sort((a, b) => a.name.localeCompare(b.name)).map((alias) => ({ value: `${alias.name}|`, label: `Through alias ${alias.name}` })),
    ...newest.map((version) => ({ value: `${version.version}|`, label: `Naming version ${version.version}` })),
    { value: `${LATEST}|`, label: `Naming no alias or version: ${LATEST}` },
    ...newest.map((version) => ({ value: `|${version.version}`, label: `Run by version ${version.version}, however named` })),
    { value: `|${LATEST}`, label: `Run by ${LATEST}, however named` },
  ];
  const value = pickValue(current);
  if (!choices.some((choice) => choice.value === value)) {
    const text = callsText(current) ?? '';
    choices.push({ value, label: `${text.charAt(0).toUpperCase()}${text.slice(1)}` });
  }
  return choices;
}
