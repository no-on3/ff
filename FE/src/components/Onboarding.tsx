import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { AccountForm, newAccountBody } from '../lib/accounts';
import { apiErrorMessage } from '../lib/functions';
import { accountsApi } from '../services/api';
import { useSession } from '../session/session';

/** Creates an account, owned by the user, which waits for approval during the beta (P-12). */
const Onboarding: React.FC = () => {
  const { me, login, switchAccount } = useSession();
  const [form, setForm] = useState<AccountForm>({ name: '', useCase: '', country: 'TN', taxId: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = me.accounts.length === 0;

  if (!login) {
    return (
      <div className="container mx-auto px-4 py-8 max-w-2xl">
        <div className="card">
          <h1 className="text-2xl font-bold mb-4">New account</h1>
          <p>Development mode acts as one account, without a user. Accounts are created by a logged-in user: see "Log in with Keycloak" in the getting-started guide.</p>
        </div>
      </div>
    );
  }

  const change = (field: keyof AccountForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [field]: event.target.value });

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const { data } = await accountsApi.createAccount(newAccountBody(form));
      switchAccount(data.id);
    } catch (failure) {
      setError(apiErrorMessage(failure));
      setSaving(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-2xl">
      <div className="card">
        <h1 className="text-2xl font-bold mb-2">{first ? 'Create your account' : 'New account'}</h1>
        <p className="text-gray-600 mb-6">
          An account holds functions and API keys, and you are its owner. During the beta, we approve each new account before it
          can deploy.
        </p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="account-name" className="block text-sm font-medium text-gray-700 mb-1">
              Name
            </label>
            <input id="account-name" className="input" required maxLength={100} value={form.name} onChange={change('name')} />
            <p className="mt-1 text-sm text-gray-500">A company, a team or a project.</p>
          </div>
          <div>
            <label htmlFor="account-use-case" className="block text-sm font-medium text-gray-700 mb-1">
              What do you plan to build? <span className="font-normal text-gray-500">(optional)</span>
            </label>
            <textarea id="account-use-case" className="input" rows={3} maxLength={1000} value={form.useCase} onChange={change('useCase')} />
            <p className="mt-1 text-sm text-gray-500">It helps us approve the account.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="account-country" className="block text-sm font-medium text-gray-700 mb-1">
                Country
              </label>
              <input
                id="account-country"
                className="input uppercase"
                required
                pattern="[A-Za-z]{2}"
                maxLength={2}
                title="Two letters: the ISO 3166 country code, such as TN"
                value={form.country}
                onChange={change('country')}
              />
            </div>
            <div>
              <label htmlFor="account-tax-id" className="block text-sm font-medium text-gray-700 mb-1">
                Tax ID <span className="font-normal text-gray-500">(optional)</span>
              </label>
              <input id="account-tax-id" className="input" maxLength={32} value={form.taxId} onChange={change('taxId')} />
              <p className="mt-1 text-sm text-gray-500">The matricule fiscal, for invoices.</p>
            </div>
          </div>
          {error && (
            <div role="alert" className="text-red-600">
              {error}
            </div>
          )}
          <div className="flex gap-3">
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Creating…' : 'Create account'}
            </button>
            {!first && (
              <Link to="/" className="btn btn-secondary">
                Cancel
              </Link>
            )}
          </div>
        </form>
      </div>
    </div>
  );
};

export default Onboarding;
