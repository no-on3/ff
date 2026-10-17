import React, { useEffect, useState } from 'react';
import { accountUpdateBody, formatWhen } from '../lib/accounts';
import { apiErrorMessage } from '../lib/functions';
import { Account, accountsApi } from '../services/api';
import { useSession } from '../session/session';

const STATUS_TEXT: Record<Account['status'], string> = {
  pending: 'Waiting for approval',
  active: 'Active',
  rejected: 'Not approved',
  suspended: 'Suspended',
  closed: 'Closed',
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <dt className="text-sm text-gray-500">{label}</dt>
    <dd className="font-medium break-words">{children}</dd>
  </div>
);

/** The chosen account: its details for every member, and the name and tax ID its owners change. */
const AccountSettings: React.FC = () => {
  const { account: chosen, login, reload } = useSession();
  const [account, setAccount] = useState<Account | null>(null);
  const [form, setForm] = useState({ name: '', taxId: '' });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Keyed by the account's ID only: a renewed token or a reloaded GET /me must not reset what the user is typing.
  const accountId = chosen?.id;
  const loggedIn = login !== null;
  useEffect(() => {
    if (!accountId || !loggedIn) return;
    accountsApi
      .getAccount(accountId)
      .then(({ data }) => {
        setAccount(data);
        setForm({ name: data.name, taxId: data.taxId ?? '' });
      })
      .catch((failure) => setError(apiErrorMessage(failure)));
  }, [accountId, loggedIn]);

  if (!chosen) return null;

  if (!login) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-3xl">
        <div className="card">
          <h1 className="text-2xl font-bold mb-4">Account</h1>
          <dl className="grid gap-4 sm:grid-cols-3 mb-6">
            <Field label="Name">{chosen.name}</Field>
            <Field label="ID">{chosen.id}</Field>
            <Field label="Status">{STATUS_TEXT[chosen.status]}</Field>
          </dl>
          <p className="text-gray-600">
            Development mode acts as this account, without a user. Log in to change accounts and manage API keys: see "Log in
            with Keycloak" in the getting-started guide.
          </p>
        </div>
      </div>
    );
  }

  const owner = chosen.role === 'owner';
  const changes = account ? accountUpdateBody(account, form) : {};

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!account) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const { data } = await accountsApi.updateAccount(account.id, changes);
      setAccount(data);
      setForm({ name: data.name, taxId: data.taxId ?? '' });
      setSaved(true);
      if (changes.name !== undefined) await reload(); // the header shows the name
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">Account</h1>
      {error && (
        <div role="alert" className="mb-4 text-red-600">
          {error}
        </div>
      )}
      {account && (
        <>
          <div className="card mb-6">
            <dl className="grid gap-4 sm:grid-cols-3">
              <Field label="ID">{account.id}</Field>
              <Field label="Status">{STATUS_TEXT[account.status]}</Field>
              <Field label="Your role">{account.role}</Field>
              <Field label="Plan">{account.planId}</Field>
              <Field label="Country">{account.country}</Field>
              <Field label="Internet access for functions">{account.internetEgress ? 'Yes' : 'No'}</Field>
              <Field label="Created">{formatWhen(account.createdAt)}</Field>
            </dl>
            {account.useCase && (
              <dl className="mt-4">
                <Field label="What you plan to build">{account.useCase}</Field>
              </dl>
            )}
          </div>
          <form onSubmit={handleSubmit} className="card space-y-4">
            <h2 className="text-lg font-semibold">Details</h2>
            {!owner && <p className="text-sm text-gray-500">Only the account's owners change these.</p>}
            <div>
              <label htmlFor="settings-name" className="block text-sm font-medium text-gray-700 mb-1">
                Name
              </label>
              <input
                id="settings-name"
                className="input"
                required
                maxLength={100}
                disabled={!owner}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="settings-tax-id" className="block text-sm font-medium text-gray-700 mb-1">
                Tax ID <span className="font-normal text-gray-500">(matricule fiscal, for invoices)</span>
              </label>
              <input
                id="settings-tax-id"
                className="input"
                maxLength={32}
                disabled={!owner}
                value={form.taxId}
                onChange={(event) => setForm({ ...form, taxId: event.target.value })}
              />
            </div>
            {owner && (
              <div className="flex items-center gap-3">
                <button type="submit" className="btn btn-primary" disabled={saving || Object.keys(changes).length === 0}>
                  {saving ? 'Saving…' : 'Save'}
                </button>
                {saved && <span className="text-green-700">Saved</span>}
              </div>
            )}
          </form>
        </>
      )}
    </div>
  );
};

export default AccountSettings;
