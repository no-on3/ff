import React, { useCallback, useEffect, useState } from 'react';
import { auditApi } from '../api';
import DataTable, { Column, Filter } from '../components/DataTable';
import { ErrorState } from '../components/States';
import { OPERATOR_ACTIONS, OperatorAction, actionLabel, auditCsvName, auditParams, describeAction, exportParams } from '../lib/audit';
import { apiErrorMessage, notAnOperator } from '../lib/errors';
import { TableQuery, currentCursor, firstPage, nextPage, pageNumber, previousPage } from '../lib/table';
import { whenUtc } from '../lib/time';

const FILTERS: Filter[] = [
  { name: 'operator', label: 'Operator', placeholder: 'part of an e-mail' },
  { name: 'accountId', label: 'Account', placeholder: '12 digits' },
  { name: 'action', label: 'Action', options: OPERATOR_ACTIONS },
  { name: 'from', label: 'From (UTC day)', type: 'date' },
  { name: 'to', label: 'To (UTC day, included)', type: 'date' },
];

const COLUMNS: Array<Column<OperatorAction>> = [
  { label: 'When', cell: (entry) => whenUtc(entry.at), className: 'whitespace-nowrap' },
  { label: 'Operator', cell: (entry) => entry.operator.email },
  { label: 'Action', cell: (entry) => actionLabel(entry.action), className: 'whitespace-nowrap' },
  { label: 'Account', cell: (entry) => (entry.accountId ? <span className="font-mono">{entry.accountId}</span> : '–') },
  { label: 'What', cell: (entry) => describeAction(entry) },
  { label: 'Reason', cell: (entry) => entry.reason ?? '' },
];

/** Saves text as a file, from the browser. */
function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/** Every operator action (P-76): who did what, when, on which account, and why. */
const AuditLog: React.FC<{ email: string | undefined }> = ({ email }) => {
  const [query, setQuery] = useState<TableQuery>({ search: '', filters: {} });
  const [paging, setPaging] = useState(firstPage());
  const [page, setPage] = useState<{ rows: OperatorAction[]; next: string | null } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  const load = useCallback(async (current: TableQuery, before: string | null) => {
    setPage(null);
    setFailure(null);
    try {
      const { data } = await auditApi.page(auditParams(current, before));
      setPage({ rows: data.entries, next: data.next });
    } catch (error) {
      if (notAnOperator(error)) setRefused(true);
      else setFailure(apiErrorMessage(error));
    }
  }, []);

  useEffect(() => {
    void load(query, currentCursor(paging));
  }, [load, query, paging]);

  if (refused) return <ErrorState message={`You are logged in as ${email ?? 'someone'}, who isn't one of FF's operators.`} />;

  const exportCsv = async () => {
    setExportNote(null);
    try {
      const { text, truncated } = await auditApi.csv(exportParams(query));
      download(auditCsvName(new Date()), text);
      if (truncated) setExportNote('The CSV holds the newest 10,000 entries that match: narrow the filters for the others.');
    } catch (error) {
      setExportNote(apiErrorMessage(error));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Audit log</h1>
          <p className="text-gray-600">What FF's operators did, newest first: when, on which account, and why.</p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={exportCsv}>
          Download as CSV
        </button>
      </div>
      {exportNote && (
        <p role="status" className="rounded bg-amber-50 px-3 py-2 text-amber-900">
          {exportNote}
        </p>
      )}
      <DataTable
        columns={COLUMNS}
        rows={page?.rows ?? null}
        rowKey={(entry) => entry.id}
        error={failure}
        empty="No operator action matches."
        filters={FILTERS}
        onQuery={(next) => {
          setQuery(next);
          setPaging(firstPage());
        }}
        page={pageNumber(paging)}
        hasNext={Boolean(page?.next)}
        onNext={() => page?.next && setPaging(nextPage(paging, page.next))}
        onPrevious={() => setPaging(previousPage(paging))}
      />
    </div>
  );
};

export default AuditLog;
