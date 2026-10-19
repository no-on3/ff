import React, { useState } from 'react';
import { apiErrorMessage } from '../lib/functions';
import { EMAIL_LANGUAGES, Locale, accountsApi } from '../services/api';
import { useSession } from '../session/session';

/**
 * The language of the e-mails FF sends the logged-in user, for all their
 * accounts: French at first, or English. Saved as soon as it is chosen.
 */
const EmailLanguage: React.FC = () => {
  const { me, reload } = useSession();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me.user) return null;
  const current = EMAIL_LANGUAGES.find((language) => language.locale === me.user?.locale)?.locale ?? 'fr-TN';

  const choose = async (locale: Locale) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await accountsApi.updateMe({ locale });
      await reload();
      setSaved(true);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card mb-6">
      <h2 className="text-lg font-semibold mb-1">Your e-mails</h2>
      <p className="mb-4 text-sm text-gray-500">The language of the e-mails FF sends you, about all your accounts: approvals, invitations, credit, payments and invoices.</p>
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="email-language" className="text-sm font-medium text-gray-700">
          Language
        </label>
        <select
          id="email-language"
          className="input w-auto"
          value={current}
          disabled={saving}
          onChange={(event) => void choose(event.target.value as Locale)}
        >
          {EMAIL_LANGUAGES.map(({ locale, label }) => (
            <option key={locale} value={locale} lang={locale}>
              {label}
            </option>
          ))}
        </select>
        {saving && <span className="text-gray-500">Saving…</span>}
        {saved && !saving && <span className="text-green-700">Saved</span>}
      </div>
      {error && (
        <div role="alert" className="mt-3 text-red-600">
          {error}
        </div>
      )}
    </div>
  );
};

export default EmailLanguage;
