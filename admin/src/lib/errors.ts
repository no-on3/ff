import axios from 'axios';

/** What the API said went wrong, for the operator: its message, or each problem of a validation list. */
export function apiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const message = (error.response?.data as { message?: unknown } | undefined)?.message;
    if (Array.isArray(message)) return message.map(String).join('; ');
    if (typeof message === 'string' && message) return message;
    if (!error.response) return `Can't reach the API: ${error.message}`;
    return `The API answered ${error.response.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Whether the API refused because the caller isn't an operator: a logged-in user without the role. */
export function notAnOperator(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 403;
}
