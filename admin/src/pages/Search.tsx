import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { supportApi } from '../api';
import { Table } from '../components/Facts';
import { ErrorState, Loading } from '../components/States';
import StatusBadge from '../components/StatusBadge';
import { ownersOf } from '../lib/accounts';
import { apiErrorMessage, notAnOperator } from '../lib/errors';
import { SearchResults, foundIn, searchSummary } from '../lib/support';
import { whenUtc } from '../lib/time';

/**
 * Support's search: one text, found as an account (its ID, its name, a
 * member's e-mail), a function (its ID or a part of its name) and a call (the
 * request ID a customer quotes). The text is in the address, so a search can
 * be linked to.
 */
const Search: React.FC<{ email: string | undefined }> = ({ email }) => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const q = (params.get('q') ?? '').trim();
  const [text, setText] = useState(q);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);

  useEffect(() => setText(q), [q]);
  useEffect(() => {
    if (!q) return;
    let cancelled = false;
    setResults(null);
    setFailure(null);
    supportApi.search(q).then(
      ({ data }) => !cancelled && setResults(data),
      (error: unknown) => {
        if (cancelled) return;
        if (notAnOperator(error)) setRefused(true);
        else setFailure(apiErrorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [q]);

  if (refused) return <ErrorState message={`You are logged in as ${email ?? 'someone'}, who isn't one of FF's operators.`} />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Search</h1>
        <p className="text-gray-600">An account's ID or name, a member's e-mail, a function's ID or name, or the request ID of a call a customer asks about.</p>
      </div>
      <form
        role="search"
        className="flex flex-wrap gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) navigate(`/search?q=${encodeURIComponent(text.trim())}`);
        }}
      >
        <input aria-label="Search for" className="input max-w-xl flex-1" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} />
        <button type="submit" className="btn btn-primary">
          Search
        </button>
      </form>
      {failure && <ErrorState message={failure} />}
      {q && !results && !failure && <Loading />}
      {results && (
        <>
          <p role="status" className="text-gray-700">
            {searchSummary(results, q)}
          </p>
          {results.calls.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Calls</h2>
              <Table
                head={['Request ID', 'Function', 'Account', 'Outcome', 'At', 'Found in']}
                rows={results.calls.map((call) => [
                  <span className="font-mono text-xs">{call.requestId}</span>,
                  call.functionExists ? (
                    <Link to={`/functions/${call.functionId}?call=${call.invocationId ?? call.requestId}`} className="text-blue-700 hover:underline">
                      {call.functionName}
                    </Link>
                  ) : (
                    `${call.functionName} (deleted)`
                  ),
                  <Link to={`/accounts/${call.accountId}`} className="font-mono text-blue-700 hover:underline">
                    {call.accountId}
                  </Link>,
                  call.attempt && call.attempt > 1 ? `${call.status} · attempt ${call.attempt}` : call.status,
                  whenUtc(call.at),
                  foundIn(call),
                ])}
              />
            </section>
          )}
          {results.functions.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Functions</h2>
              <Table
                head={['Function', 'Runtime', 'Status', 'Account']}
                rows={results.functions.map((fn) => [
                  <Link to={`/functions/${fn.id}`} className="font-medium text-blue-700 hover:underline">
                    {fn.name}
                    <span className="block font-mono text-xs font-normal text-gray-500">{fn.id}</span>
                  </Link>,
                  fn.runtime,
                  fn.status,
                  <Link to={`/accounts/${fn.accountId}`} className="text-blue-700 hover:underline">
                    {fn.accountName}
                  </Link>,
                ])}
              />
            </section>
          )}
          {results.accounts.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Accounts</h2>
              <Table
                head={['Account', 'Status', 'Owners', 'Created']}
                rows={results.accounts.map((account) => [
                  <Link to={`/accounts/${account.id}`} className="font-medium text-blue-700 hover:underline">
                    {account.name}
                    <span className="block font-mono text-xs font-normal text-gray-500">{account.id}</span>
                  </Link>,
                  <StatusBadge status={account.status} />,
                  ownersOf(account),
                  whenUtc(account.createdAt),
                ])}
              />
            </section>
          )}
        </>
      )}
    </div>
  );
};

export default Search;
