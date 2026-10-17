/**
 * The admin dashboard's tables (P-70): a page at a time, newest first, with
 * filters and a search, as the admin routes take them: `limit`, the previous
 * page's `next` as `before`, and one query parameter per filter.
 */
export interface TableQuery {
  /** Free text, for routes that search. */
  search: string;
  /** One value per filter; empty means any. */
  filters: Record<string, string>;
}

export const PAGE_SIZE = 50;

/** The query parameters of one page: empty filters and searches left out. */
export function pageParams(query: TableQuery, before: string | null, limit = PAGE_SIZE): Record<string, string> {
  const params: Record<string, string> = { limit: String(limit) };
  if (query.search.trim()) params.q = query.search.trim();
  for (const [name, value] of Object.entries(query.filters)) if (value.trim()) params[name] = value.trim();
  if (before) params.before = before;
  return params;
}

/**
 * Where the table is: the cursors of the pages before this one, so "Previous"
 * goes back without the API keeping any state. A new query starts over.
 */
export interface Paging {
  /** `before` of each page seen so far; the last is the current page's (null: the first page). */
  cursors: Array<string | null>;
}

export const firstPage = (): Paging => ({ cursors: [null] });
export const currentCursor = (paging: Paging): string | null => paging.cursors[paging.cursors.length - 1];
export const nextPage = (paging: Paging, next: string): Paging => ({ cursors: [...paging.cursors, next] });
export const previousPage = (paging: Paging): Paging => (paging.cursors.length > 1 ? { cursors: paging.cursors.slice(0, -1) } : paging);
export const pageNumber = (paging: Paging): number => paging.cursors.length;
