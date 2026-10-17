import type { Function, FunctionUpdate } from '../services/api';

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

/** The API reports memory in MB already: "98 MB", or "N/A" when the runtime reported nothing. */
export function formatMemory(mb: number | null | undefined): string {
  return typeof mb === 'number' && mb > 0 ? `${Math.round(mb)} MB` : 'N/A';
}

/** "1.09 ms", or "N/A". */
export function formatDuration(ms: number | null | undefined): string {
  return typeof ms === 'number' && ms > 0 ? `${ms.toFixed(2)} ms` : 'N/A';
}
