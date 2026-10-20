/**
 * Text to match as itself in a LIKE or ILIKE pattern written with
 * `ESCAPE '\'`: its wildcards (% and _) and the escape character escaped.
 * Wrap it in % for "contains".
 */
export const likeLiteral = (text: string): string => text.replace(/[\\%_]/g, (character) => `\\${character}`);
