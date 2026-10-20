/** Where a change whose body is a file sends its reason (P-35), URI-encoded: the API reads it there. */
export const REASON_HEADER = 'X-FF-Reason';

/** The rule the API applies to every admin change's reason (P-70): the audit log keeps it with the change. */
export const REASON_LENGTH = { min: 3, max: 500 } as const;

/** Why a reason can't be sent yet, or null when it can. */
export function reasonProblem(text: string): string | null {
  if (text.trim().length < REASON_LENGTH.min) return `Say why, in at least ${REASON_LENGTH.min} characters: the audit log keeps it.`;
  if (text.length > REASON_LENGTH.max) return `At most ${REASON_LENGTH.max} characters.`;
  return null;
}
