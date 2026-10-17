/**
 * A readable one-line description of anything thrown. Some errors have no
 * message of their own: a refused database connection is an AggregateError
 * holding one error per address tried (IPv6, then IPv4), with an empty message.
 */
export function describeError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    const parts = [...new Set(error.errors.map(describeError))];
    return error.message ? `${error.message}: ${parts.join('; ')}` : parts.join('; ');
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return error.message || (typeof code === 'string' ? code : '') || error.name;
  }
  return String(error);
}
