import React, { useState } from 'react';
import { TableQuery } from '../lib/table';
import { EmptyState, ErrorState, Loading } from './States';

export interface Column<Row> {
  label: string;
  /** The cell's content. */
  cell: (row: Row) => React.ReactNode;
  className?: string;
}

export interface Filter {
  name: string;
  label: string;
  /** A choice; or free text when there are none. */
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
  /** A date picker rather than text. */
  type?: 'text' | 'date';
}

/**
 * A page of rows, with filters and a search above it and the pages below it
 * (P-70). It only shows: the page that owns it fetches with lib/table.ts.
 */
function DataTable<Row>({
  columns,
  rows,
  rowKey,
  error,
  empty,
  filters = [],
  initial = {},
  search,
  onQuery,
  page,
  hasNext,
  onNext,
  onPrevious,
}: {
  columns: Array<Column<Row>>;
  /** null while loading. */
  rows: Row[] | null;
  rowKey: (row: Row) => string;
  error: string | null;
  /** What an empty page means. */
  empty: string;
  filters?: Filter[];
  /** Filter values to start with, such as the approvals queue's status=pending; the page fetches with the same. */
  initial?: Record<string, string>;
  /** The search box's placeholder; no search without it. */
  search?: string;
  onQuery: (query: TableQuery) => void;
  page: number;
  hasNext: boolean;
  onNext: () => void;
  onPrevious: () => void;
}) {
  const [query, setQuery] = useState<TableQuery>(() => ({
    search: '',
    filters: Object.fromEntries(filters.map((f) => [f.name, initial[f.name] ?? ''])),
  }));
  const apply = (next: TableQuery) => {
    setQuery(next);
    onQuery(next);
  };

  return (
    <div className="space-y-4">
      {(filters.length > 0 || search) && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            onQuery(query);
          }}
        >
          {search && (
            <label className="text-sm">
              <span className="block text-gray-600">Search</span>
              <input type="search" className="input" placeholder={search} value={query.search} onChange={(e) => setQuery({ ...query, search: e.target.value })} />
            </label>
          )}
          {filters.map((filter) => (
            <label key={filter.name} className="text-sm">
              <span className="block text-gray-600">{filter.label}</span>
              {filter.options ? (
                <select
                  className="input"
                  value={query.filters[filter.name] ?? ''}
                  onChange={(e) => apply({ ...query, filters: { ...query.filters, [filter.name]: e.target.value } })}
                >
                  <option value="">Any</option>
                  {filter.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="input"
                  type={filter.type ?? 'text'}
                  placeholder={filter.placeholder}
                  value={query.filters[filter.name] ?? ''}
                  onChange={(e) => setQuery({ ...query, filters: { ...query.filters, [filter.name]: e.target.value } })}
                />
              )}
            </label>
          ))}
          <button type="submit" className="btn btn-secondary">
            Apply
          </button>
        </form>
      )}

      {error ? (
        <ErrorState message={error} />
      ) : rows === null ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <div className="card overflow-x-auto p-0">
          <table className="w-full text-left text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                {columns.map((column) => (
                  <th key={column.label} className={`px-4 py-2 font-medium ${column.className ?? ''}`}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={rowKey(row)} className="border-t border-gray-200 align-top">
                  {columns.map((column) => (
                    <td key={column.label} className={`px-4 py-2 ${column.className ?? ''}`}>
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(page > 1 || hasNext) && (
        <nav aria-label="Pages" className="flex items-center gap-3 text-sm">
          <button type="button" className="btn btn-secondary" onClick={onPrevious} disabled={page <= 1}>
            Previous
          </button>
          <span className="text-gray-600">Page {page}</span>
          <button type="button" className="btn btn-secondary" onClick={onNext} disabled={!hasNext}>
            Next
          </button>
        </nav>
      )}
    </div>
  );
}

export default DataTable;
