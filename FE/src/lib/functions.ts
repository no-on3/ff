import type { Function, FunctionUpdate, PlanLimits, ScalingLimits } from '../services/api';

/**
 * AWS Lambda's rule for a function's name, which the API applies, as an HTML
 * `pattern`: the browser anchors it, and its `v` flag wants the hyphen escaped.
 */
export const FUNCTION_NAME_PATTERN = '[A-Za-z0-9_\\-]{1,64}';
/** The longest name the rule allows: the forms stop there rather than send one the API refuses. */
export const MAX_FUNCTION_NAME_LENGTH = 64;
/** The rule in words, for the forms. */
export const FUNCTION_NAME_RULE = '1 to 64 letters, digits, hyphens or underscores';

/** The fields the console's edit form changes. */
export type EditableFields = Pick<Function, 'name' | 'code' | 'memory' | 'timeout'>;

const EDITABLE: ReadonlyArray<keyof EditableFields> = ['name', 'code', 'memory', 'timeout'];

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

export type ParsedInput = { ok: true; input: Record<string, unknown> } | { ok: false; error: string };

/** The invoke form's text as the API's `input`: empty means {}, and it must be a JSON object. */
export function parseInvokeInput(text: string): ParsedInput {
  if (text.trim() === '') return { ok: true, input: {} };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: 'The input is not valid JSON' };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'The input must be a JSON object, such as {"name": "FF"}' };
  }
  return { ok: true, input: value as Record<string, unknown> };
}

/**
 * What the history says of a value it kept only the start of: it keeps at most
 * 64 KiB of each input, output and error, the personal data of the customer's users.
 */
export const TRUNCATED_NOTE = 'Truncated: the history keeps the first 64 KiB.';

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
