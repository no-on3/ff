import type { Function, FunctionUpdate, InvocationSource, InvocationStatus, PlanLimits, ScalingLimits } from '../services/api';

/**
 * AWS Lambda's rule for a function's name, which the API applies, as an HTML
 * `pattern`: the browser anchors it, and its `v` flag wants the hyphen escaped.
 */
export const FUNCTION_NAME_PATTERN = '[A-Za-z0-9_\\-]{1,64}';
/** The longest name the rule allows: the forms stop there rather than send one the API refuses. */
export const MAX_FUNCTION_NAME_LENGTH = 64;
/** The rule in words, for the forms. */
export const FUNCTION_NAME_RULE = '1 to 64 letters, digits, hyphens or underscores';

/** The fields the console's edit form changes. The event format, only for a function that still gets FF's original event. */
export type EditableFields = Pick<Function, 'name' | 'code' | 'memory' | 'timeout' | 'eventFormat'>;

const EDITABLE: ReadonlyArray<keyof EditableFields> = ['name', 'code', 'memory', 'timeout', 'eventFormat'];

/**
 * The body of PUT /functions/:id for an edit: only the editable fields that
 * changed. The API refuses any field it doesn't accept (id, status, …) with 400.
 */
export function changedFields(original: Function, edited: EditableFields): FunctionUpdate {
  const update: Record<string, unknown> = {};
  for (const key of EDITABLE) {
    if (edited[key] !== original[key]) update[key] = edited[key];
  }
  return update as FunctionUpdate;
}

/**
 * The API's own explanation of a failed request: NestJS sends `message`, a
 * string or a list of validation errors. Else the error's message.
 */
export function apiErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error) return error;
  const message = (error as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
  if (Array.isArray(message) && message.length > 0) return message.map(String).join('; ');
  if (typeof message === 'string' && message) return message;
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong';
}

/** The field of a failed create's answer that names the function the API saved all the same, as ERROR. */
export const SAVED_FUNCTION_FIELD = 'functionId';

/** Why a create failed, and the function it saved anyway, when it got that far. */
export interface CreateFailure {
  message: string;
  functionId?: string;
}

/**
 * A failed create as the console acts on it. When the code failed to load, the
 * function exists: the console opens it to be fixed, as a form still filled in
 * would only create it a second time.
 */
export function createFailure(error: unknown): CreateFailure {
  const saved = (error as { response?: { data?: Record<string, unknown> } } | null)?.response?.data?.[SAVED_FUNCTION_FIELD];
  return { message: apiErrorMessage(error), ...(typeof saved === 'string' && saved ? { functionId: saved } : {}) };
}

export type ParsedInput = { ok: true; input: unknown } | { ok: false; error: string };

/** The invoke form's text as the API's `input`: empty means {}, else any JSON value, as AWS Lambda takes a payload. */
export function parseInvokeInput(text: string): ParsedInput {
  if (text.trim() === '') return { ok: true, input: {} };
  try {
    return { ok: true, input: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: 'The input is not valid JSON' };
  }
}

/** A size in bytes, as people read one: bytes, KB or MB, decimal, as the API's limits say them. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** A function's code, said for its page: inline or a package, its size, and the hash that names it. */
export function codeText(func: Pick<Function, 'packageType' | 'codeSize' | 'codeSha256'>): string {
  const kind = func.packageType === 'zip' ? 'A package' : 'Inline code';
  return `${kind}, ${formatBytes(func.codeSize)}, SHA-256 ${func.codeSha256}`;
}

/** What a function's handler gets, said for its page: its event format, in words. */
export function eventFormatText(func: Pick<Function, 'eventFormat'>): string {
  return func.eventFormat === 'wrapped'
    ? "FF's original event: the input in event.body, inside the request FF sent the function"
    : "AWS Lambda's event: the input itself";
}

/**
 * What the history says of a value it kept only the start of: it keeps at most
 * 64 KiB of each input, output and error, the personal data of the customer's users.
 */
export const TRUNCATED_NOTE = 'Truncated: the history keeps the first 64 KiB.';

/** What brought a call, as the history says it. */
export const sourceText = (source: InvocationSource): string =>
  ({ api: 'through the API', url: 'through its URL', schedule: 'by a schedule' })[source] ?? source;

/**
 * An input or output as the history shows it: its JSON, indented; or, when
 * the history kept only the start of its JSON text, that start as it is.
 */
export function historyText(value: unknown, truncated: boolean): string {
  if (truncated && typeof value === 'string') return value;
  return JSON.stringify(value, null, 2) ?? '';
}

/** The API reports memory in MB already: "98 MB", or "N/A" when the runtime reported nothing. */
export function formatMemory(mb: number | null | undefined): string {
  return typeof mb === 'number' && mb > 0 ? `${Math.round(mb)} MB` : 'N/A';
}

/** "1.09 ms", or "N/A". */
export function formatDuration(ms: number | null | undefined): string {
  return typeof ms === 'number' && ms > 0 ? `${ms.toFixed(2)} ms` : 'N/A';
}

/** Why the API would refuse these limits, or null: the same rules, and the account's plan's maximum (P-15). */
export function scalingLimitsError(
  { minInstances, maxInstances }: ScalingLimits,
  plan: { name: string; limits: Pick<PlanLimits, 'instancesPerFunction'> },
): string | null {
  const limit = plan.limits.instancesPerFunction;
  const onPlan = `on the ${plan.name} plan`;
  if (!Number.isInteger(minInstances) || minInstances < 0 || minInstances > limit) {
    return `Minimum instances must be a whole number from 0 to ${limit} ${onPlan}`;
  }
  if (!Number.isInteger(maxInstances) || maxInstances < 1 || maxInstances > limit) {
    return `Maximum instances must be a whole number from 1 to ${limit} ${onPlan}`;
  }
  if (minInstances > maxInstances) return "Minimum instances can't be more than maximum instances";
  return null;
}

/**
 * An invocation's status as the history shows it: a word, its pill's tone, and for the two that aren't billed, why.
 * THROTTLED: no instance could take the call in time (P-15); LOST: the backend stopped during the call (P-20).
 */
export const INVOCATION_STATUS_INFO: Record<InvocationStatus, { label: string; tone: 'ok' | 'busy' | 'failed' | 'warn' | 'idle'; note?: string }> = {
  SUCCESS: { label: 'Succeeded', tone: 'ok' },
  COMPLETED: { label: 'Completed', tone: 'ok' },
  RUNNING: { label: 'Running', tone: 'busy' },
  ERROR: { label: 'Error', tone: 'failed' },
  TIMEOUT: { label: 'Timed out', tone: 'failed' },
  THROTTLED: { label: 'Throttled', tone: 'warn', note: 'Not billed: no instance could take the call in time. Try again.' },
  LOST: { label: 'Lost', tone: 'idle', note: 'Not billed: the backend stopped during the call, so its answer is unknown.' },
};
