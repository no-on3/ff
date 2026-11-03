import { invalidParameterValue } from './lambda-error';

/*
 * A request's fields, read as Lambda's model types them: each refused in
 * Lambda's names, saying what it must be, before FF's own checks of the values.
 */

/** A value as a refusal shows it: a string as sent, anything else as JSON. */
export const said = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Sent with nothing in it: absent, null, false, empty, or an object of such, as the tools send a setting left at its default. */
export const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || value === false || value === '' || (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.values(value).every(isEmpty));

/** A field an operation doesn't take: refused, never ignored. */
export function refuseUnknownFields(input: Record<string, unknown>, operation: string, taken: ReadonlySet<string>): void {
  const unknown = Object.keys(input).find((field) => !taken.has(field));
  if (unknown !== undefined) throw invalidParameterValue(`FF doesn't take ${unknown} in ${operation}.`);
}

/** An object without the fields left undefined, as FF's DTOs take one. */
export const defined = <T extends object>(fields: T): T => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as T;

/** A field sent as a string, of `max` characters at most; undefined when not sent. */
export function text(input: Record<string, unknown>, field: string, max?: number): string | undefined {
  const sent = input[field];
  if (sent === undefined) return undefined;
  if (typeof sent !== 'string') throw invalidParameterValue(`${field} must be a string.`);
  if (max !== undefined && sent.length > max) throw invalidParameterValue(`${field} must be at most ${max} characters.`);
  return sent;
}

/** A field that names one of `values`, `why` said after them; undefined when not sent. */
export function oneOf<T extends string>(input: Record<string, unknown>, field: string, values: readonly T[], why = ''): T | undefined {
  const sent = input[field];
  if (sent === undefined) return undefined;
  const known = values.find((value) => value === sent);
  if (known === undefined) throw invalidParameterValue(`${field} must be ${values.join(' or ')}${why}, not ${said(sent)}.`);
  return known;
}
