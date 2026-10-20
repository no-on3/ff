import React, { useEffect, useState } from 'react';
import { SettingsView, settingsApi } from '../api';
import ReasonDialog from '../components/ReasonDialog';
import { ErrorState, Loading } from '../components/States';
import { apiErrorMessage, notAnOperator } from '../lib/errors';
import { PlatformSettings, SETTINGS, SettingKey, changedSettings, describeSetting, formOf } from '../lib/settings';

/** The platform's settings (P-70, D12): each change saved with a reason, which the audit log keeps. */
const Settings: React.FC<{ email: string | undefined }> = ({ email }) => {
  const [view, setView] = useState<SettingsView | null>(null);
  const [form, setForm] = useState<Record<SettingKey, string> | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [confirming, setConfirming] = useState<Partial<PlatformSettings> | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    settingsApi
      .get()
      .then(({ data }) => {
        setView(data);
        setForm(formOf(data.settings));
      })
      .catch((error) => (notAnOperator(error) ? setRefused(true) : setFailure(apiErrorMessage(error))));
  }, []);

  if (refused) {
    return <ErrorState message={`You are logged in as ${email ?? 'someone'}, who isn't one of FF's operators.`} />;
  }
  if (failure) return <ErrorState message={failure} />;
  if (!view || !form) return <Loading />;

  const review = (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const { changes, problems: found } = changedSettings(form, view.settings);
    setProblems(found);
    if (found.length === 0) setConfirming(changes);
  };
  const save = async (reason: string) => {
    try {
      const { data } = await settingsApi.update(confirming ?? {}, reason);
      setView(data);
      setForm(formOf(data.settings));
      setConfirming(null);
      setSaved(true);
    } catch (error) {
      throw new Error(apiErrorMessage(error));
    }
  };
  const changed = confirming ? SETTINGS.filter(({ key }) => key in confirming) : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-gray-600">Billing and platform values. Each change is saved with a reason, in the audit log.</p>
      </div>
      <form onSubmit={review} className="card space-y-5">
        {SETTINGS.map(({ key, label, help, kind, unit }) => (
          <div key={key} className="grid gap-1 sm:grid-cols-[14rem_1fr] sm:gap-6">
            <label htmlFor={key} className="font-medium">
              {label}
            </label>
            <div className="space-y-1">
              {kind === 'boolean' ? (
                <select id={key} className="input max-w-xs" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })}>
                  <option value="true">On</option>
                  <option value="false">Off</option>
                </select>
              ) : (
                <div className="flex items-center gap-2">
                  <input id={key} className="input max-w-xs" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
                  {unit && <span className="text-sm text-gray-500">{unit}</span>}
                </div>
              )}
              <p className="text-sm text-gray-500">
                {help} Default: {describeSetting(kind, view.defaults[key])}.
              </p>
            </div>
          </div>
        ))}
        {problems.length > 0 && <ErrorState message={problems.join(' ')} />}
        {saved && (
          <p role="status" className="text-green-800">
            Saved.
          </p>
        )}
        <button type="submit" className="btn btn-primary">
          Review and save…
        </button>
      </form>

      {confirming && (
        <ReasonDialog
          title={changed.length ? 'Save these changes?' : 'Nothing to save'}
          confirmLabel="Save"
          onConfirm={save}
          onCancel={() => setConfirming(null)}
        >
          {changed.length ? (
            <ul className="list-disc space-y-1 pl-5">
              {changed.map(({ key, label, kind }) => (
                <li key={key}>
                  {label}: {describeSetting(kind, view.settings[key])} → {describeSetting(kind, confirming[key])}
                </li>
              ))}
            </ul>
          ) : (
            <p>The values are the ones already set.</p>
          )}
        </ReasonDialog>
      )}
    </div>
  );
};

export default Settings;
