import React, { useEffect, useState } from 'react';
import { config } from '../config';
import { formatWhen } from '../lib/accounts';
import { EXPIRY_CHOICES, SCOPE_INFO, expiresAtFor, keyPrefix, keyState } from '../lib/api-keys';
import { apiErrorMessage } from '../lib/functions';
import { ApiKey, CreatedApiKey, SCOPES, Scope, apiKeysApi } from '../services/api';
import { useSession } from '../session/session';

const STATE_BADGE = {
  active: 'bg-green-100 text-green-800',
  revoked: 'bg-gray-200 text-gray-700',
  expired: 'bg-amber-100 text-amber-900',
} as const;

const Page: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="container mx-auto px-4 py-8 max-w-5xl">
    <h1 className="text-2xl font-bold mb-6">API keys</h1>
    {children}
  </div>
);

/** The new key, shown once: the API keeps only its hash (P-13). */
const NewKey: React.FC<{ created: CreatedApiKey; onDone(): void }> = ({ created, onDone }) => {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      setCopied(false); // the browser refused: the key stays selectable
    }
  };
  return (
    <div role="status" className="card mb-6 border border-green-300">
      <h2 className="text-lg font-semibold mb-2">Your new key "{created.name}"</h2>
      <p className="mb-3 text-amber-900">Copy it now: it is shown only once. Keep it in a secret store, such as your CI's secrets.</p>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <code data-testid="new-api-key" className="select-all break-all rounded bg-gray-100 px-3 py-2 font-mono text-sm">
          {created.key}
        </code>
        <button type="button" className="btn btn-secondary" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {created.scopes.includes('functions:read') && (
        <p className="mb-3 text-sm text-gray-600">
          Try it: <code className="break-all">curl -H "Authorization: Bearer $FF_API_KEY" {config.apiUrl}/functions</code>
        </p>
      )}
      <button type="button" className="btn btn-primary" onClick={onDone}>
        Done
      </button>
    </div>
  );
};

/** The account's API keys, for scripts, CI and the CLI: its owners list, create and revoke them (P-13). */
const ApiKeys: React.FC = () => {
  const { account, login } = useSession();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['functions:read']);
  const [expiryDays, setExpiryDays] = useState<number | null>(90);
  const [saving, setSaving] = useState(false);

  const owner = account?.role === 'owner';
  const accountId = account?.id;
  const loggedIn = login !== null;
  useEffect(() => {
    if (!accountId || !loggedIn || !owner) return;
    apiKeysApi
      .listKeys()
      .then(({ data }) => setKeys(data))
      .catch((failure) => setError(apiErrorMessage(failure)));
  }, [accountId, loggedIn, owner]);

  if (!account) return null;
  if (!login) {
    return (
      <Page>
        <div className="card">
          Development mode acts without a user, and API keys belong to a user's account: log in to manage them (see "Log in with
          Keycloak" in the getting-started guide). Development mode reads no key either.
        </div>
      </Page>
    );
  }
  if (!owner) {
    return (
      <Page>
        <div className="card">Only the account's owners manage its API keys.</div>
      </Page>
    );
  }

  const toggleScope = (scope: Scope) =>
    setScopes(scopes.includes(scope) ? scopes.filter((s) => s !== scope) : SCOPES.filter((s) => s === scope || scopes.includes(s)));

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { data } = await apiKeysApi.createKey({ name: name.trim(), scopes, expiresAt: expiresAtFor(expiryDays, new Date()) });
      setCreated(data);
      setName('');
      setKeys((await apiKeysApi.listKeys()).data); // the list, as the API keeps it: without the secret
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  const handleRevoke = async (key: ApiKey) => {
    if (!window.confirm(`Revoke "${key.name}"? Anything that uses it stops working at once.`)) return;
    setError(null);
    try {
      const { data } = await apiKeysApi.revokeKey(key.id);
      setKeys((keys ?? []).map((k) => (k.id === data.id ? data : k)));
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  };

  const now = new Date();
  return (
    <Page>
      <p className="mb-6 text-gray-600">
        A key acts for this account in scripts, CI and the CLI: send it as <code>Authorization: Bearer &lt;key&gt;</code>. It can
        do what its scopes allow, and never more than its creator's role.
      </p>
      {created && <NewKey created={created} onDone={() => setCreated(null)} />}
      {error && (
        <div role="alert" className="mb-4 text-red-600">
          {error}
        </div>
      )}

      <form onSubmit={handleCreate} className="card mb-6 space-y-4">
        <h2 className="text-lg font-semibold">New key</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="key-name" className="block text-sm font-medium text-gray-700 mb-1">
              Name
            </label>
            <input
              id="key-name"
              className="input"
              required
              maxLength={100}
              placeholder="CI deploys"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="key-expiry" className="block text-sm font-medium text-gray-700 mb-1">
              Expires
            </label>
            <select
              id="key-expiry"
              className="input bg-white"
              value={expiryDays ?? ''}
              onChange={(event) => setExpiryDays(event.target.value === '' ? null : Number(event.target.value))}
            >
              {EXPIRY_CHOICES.map((choice) => (
                <option key={choice.label} value={choice.days ?? ''}>
                  {choice.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <fieldset>
          <legend className="text-sm font-medium text-gray-700 mb-2">Scopes</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {SCOPES.map((scope) => (
              <label key={scope} className="flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={scopes.includes(scope)} onChange={() => toggleScope(scope)} />
                <span>
                  <code className="text-sm">{scope}</code>
                  <span className="block text-sm text-gray-500">{SCOPE_INFO[scope]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <button type="submit" className="btn btn-primary" disabled={saving || scopes.length === 0}>
          {saving ? 'Creating…' : 'Create key'}
        </button>
      </form>

      <div className="card overflow-x-auto">
        {keys === null ? (
          <p>Loading…</p>
        ) : keys.length === 0 ? (
          <p className="text-gray-500">No keys yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-gray-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Name</th>
                <th className="py-2 pr-4 font-medium">Key</th>
                <th className="py-2 pr-4 font-medium">Scopes</th>
                <th className="py-2 pr-4 font-medium">Created</th>
                <th className="py-2 pr-4 font-medium">Last used</th>
                <th className="py-2 pr-4 font-medium">Expires</th>
                <th className="py-2 font-medium">State</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => {
                const state = keyState(key, now);
                return (
                  <tr key={key.id} data-key-id={key.id} className="border-t border-gray-200 align-top">
                    <td className="py-2 pr-4">{key.name}</td>
                    <td className="py-2 pr-4 font-mono whitespace-nowrap">{keyPrefix(key.id)}</td>
                    <td className="py-2 pr-4">{key.scopes.join(', ')}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{formatWhen(key.createdAt)}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{key.lastUsedAt ? formatWhen(key.lastUsedAt) : 'Never'}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">{key.expiresAt ? formatWhen(key.expiresAt) : 'Never'}</td>
                    <td className="py-2 whitespace-nowrap">
                      <span className={`rounded px-2 py-0.5 ${STATE_BADGE[state]}`}>{state}</span>
                      {state === 'active' && (
                        <button type="button" className="ml-3 text-red-600 hover:text-red-800" onClick={() => handleRevoke(key)}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
};

export default ApiKeys;
