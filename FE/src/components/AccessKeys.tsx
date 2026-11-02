import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatWhen } from '../lib/accounts';
import { FUNCTION_ACCESS_INFO, type KeyDraft, NEW_KEY, draftProblem, draftReach, exportLines, keyReach, requestOf, storageChoices, tryCommand, withFunctions } from '../lib/access-keys';
import { apiErrorMessage } from '../lib/functions';
import { can } from '../lib/session';
import { CreatedStorageKey, FUNCTION_ACCESS, StorageKey, bucketsApi, functionsApi, queuesApi, storageKeysApi } from '../services/api';
import { useSession } from '../session/session';
import Copyable from './Copyable';
import { Page, PageHeader } from './Page';
import { Callout, Panel } from './Panel';

/** A key's secret, this once, as the variables AWS's SDKs and CLI read: FF keeps it sealed, and never shows it again. */
const KeyOnce: React.FC<{ made: CreatedStorageKey; command: string | null; onDone(): void }> = ({ made, command, onDone }) => (
  <Panel
    title={`Access key ${made.name}`}
    description={`${made.id}. Copy it now: its secret is shown only this once. FF keeps it sealed; revoke the key below to stop it.`}
    className="mb-6 border-green-300"
  >
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-[13px] font-medium text-gray-700">For your terminal, or a function's secrets: AWS's SDKs and CLI read these</p>
        <Copyable value={exportLines(made)} label="the access key's variables" testId="key-variables" />
      </div>
      {command && (
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-gray-700">Then, as on AWS</p>
          <Copyable value={command} label="the command" />
        </div>
      )}
      <button type="button" className="btn btn-primary" onClick={onDone}>
        Done
      </button>
    </div>
  </Panel>
);

/** Names to tick, for a new key's buckets, queues or functions; a line saying so when the account has none. */
const Picker: React.FC<{ legend: string; names: string[]; picked: string[]; none: string; onChange(picked: string[]): void }> = ({ legend, names, picked, none, onChange }) => (
  <fieldset className="min-w-0">
    <legend className="mb-1.5 text-[13px] font-medium text-gray-700">{legend}</legend>
    {names.length === 0 ? (
      <p className="text-[13px] text-gray-500">{none}</p>
    ) : (
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {names.map((name) => (
          <label key={name} className="inline-flex items-center gap-1.5 font-mono text-[13px] text-gray-800">
            <input type="checkbox" checked={picked.includes(name)} onChange={(e) => onChange(e.target.checked ? [...picked, name] : picked.filter((each) => each !== name))} />
            {name}
          </label>
        ))}
      </div>
    )}
  </fieldset>
);

const STORAGE_LABELS: Record<KeyDraft['storage'], string> = {
  all: 'Every bucket and queue, and the mail',
  some: 'Those I pick',
  none: 'None',
};

const FUNCTION_LABELS: Record<KeyDraft['functions'], string> = {
  none: 'None',
  all: "All the account's",
  some: 'Those I pick',
};

/** A choice of a few, as radio buttons in a row. */
function Choice<T extends string>({ legend, name, value, options, labels, onChange }: { legend: string; name: string; value: T; options: T[]; labels: Record<T, string>; onChange(value: T): void }) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium text-gray-700">{legend}</legend>
      <div className="flex flex-wrap gap-x-5 gap-y-1.5">
        {options.map((option) => (
          <label key={option} className="inline-flex items-center gap-1.5 text-[13px] text-gray-800">
            <input type="radio" name={name} checked={value === option} onChange={() => onChange(option)} />
            {labels[option]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The form of a new key: its name, its buckets and queues, its functions at a level, and what it will reach, said as the list says it. */
const NewKeyForm: React.FC<{ names: { buckets: string[]; queues: string[]; functions: string[] }; busy: boolean; onMake(draft: KeyDraft): void }> = ({ names, busy, onMake }) => {
  const [draft, setDraft] = useState<KeyDraft>(NEW_KEY);
  const change = (fields: Partial<KeyDraft>) => setDraft((current) => ({ ...current, ...fields }));
  const problem = draftProblem(draft);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!problem) onMake(draft);
  };
  return (
    <form onSubmit={submit} className="space-y-5" aria-label="New access key">
      <div>
        <label htmlFor="key-name" className="mb-1.5 block text-sm font-medium text-gray-700">
          Name
        </label>
        <input id="key-name" className="input max-w-sm font-mono" maxLength={64} placeholder="its ID, when none is given" value={draft.name} onChange={(e) => change({ name: e.target.value.trim() })} />
        <p className="mt-1 text-xs text-gray-500">As an IAM user's: letters, digits and +=,.@_-, once among the account's keys.</p>
      </div>
      <div className="space-y-3">
        <Choice legend="Its buckets and queues" name="key-storage" value={draft.storage} options={storageChoices(draft)} labels={STORAGE_LABELS} onChange={(storage) => change({ storage })} />
        {draft.storage === 'some' && (
          <div className="space-y-3 rounded-md border border-line bg-gray-50/60 p-3.5">
            <Picker legend="Buckets" names={names.buckets} picked={draft.buckets} none="The account has no bucket yet." onChange={(buckets) => change({ buckets })} />
            <Picker legend="Queues" names={names.queues} picked={draft.queues} none="The account has no queue yet." onChange={(queues) => change({ queues })} />
          </div>
        )}
        {draft.storage !== 'none' && (
          <label className="inline-flex items-center gap-1.5 text-[13px] text-gray-700">
            <input type="checkbox" checked={draft.readOnly} onChange={(e) => change({ readOnly: e.target.checked })} />
            Read-only: it reads and lists them, and writes, copies and deletes nothing
          </label>
        )}
      </div>
      <div className="space-y-3">
        <Choice legend="Its functions" name="key-functions" value={draft.functions} options={['none', 'all', 'some']} labels={FUNCTION_LABELS} onChange={(functions) => setDraft((current) => withFunctions(current, functions))} />
        {draft.functions !== 'none' && (
          <div className="space-y-3 rounded-md border border-line bg-gray-50/60 p-3.5">
            {draft.functions === 'some' && (
              <Picker legend="Functions" names={names.functions} picked={draft.functionNames} none="The account has no function yet." onChange={(functionNames) => change({ functionNames })} />
            )}
            <fieldset>
              <legend className="mb-1.5 text-[13px] font-medium text-gray-700">What it may do with them</legend>
              <div className="space-y-1">
                {FUNCTION_ACCESS.map((level) => (
                  <label key={level} className="flex items-baseline gap-1.5 text-[13px] text-gray-800">
                    <input type="radio" name="key-function-access" checked={draft.functionAccess === level} onChange={() => change({ functionAccess: level })} />
                    <span>
                      <span className="font-medium">{FUNCTION_ACCESS_INFO[level].label}</span>
                      <span className="text-gray-600">: {FUNCTION_ACCESS_INFO[level].text}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            {draft.storage === 'none' && <p className="text-xs text-gray-500">Naming functions, a key reaches the buckets and queues it names too, and no other, nor the mail.</p>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="submit" className="btn btn-primary" disabled={busy || !!problem}>
          {busy ? 'Making…' : 'Make the key'}
        </button>
        <p role="status" className={`text-[13px] ${problem ? 'text-amber-900' : 'text-gray-600'}`}>
          {problem ?? `It will reach: ${draftReach(draft)}`}
        </p>
      </div>
    </form>
  );
};

/** Under the buckets' and the queues' lists: where the keys AWS's SDKs and CLI reach them with are made. */
export const AccessKeysNote: React.FC<{ owner: boolean; what: string }> = ({ owner, what }) => (
  <p className="mb-8 text-[13px] text-gray-600">
    AWS's SDKs and CLI reach {what} with one of the account's access keys:{' '}
    {owner ? (
      <Link to="/account/access-keys" className="font-medium text-ink underline">
        Access keys
      </Link>
    ) : (
      "the account's owners"
    )}{' '}
    {owner ? 'makes them, each with what it reaches.' : 'make them.'}
  </p>
);

/**
 * The account's access keys, which AWS's SDKs and CLI use for its buckets,
 * queues and mail (ADR 0009, 0010, 0012), and the functions they name (ADR
 * 0014): its owners see, make and revoke them, as many as the plan allows. A
 * key stays as it was made: another reach is another key.
 */
const AccessKeys: React.FC = () => {
  const { account } = useSession();
  const owner = account !== null && can(account.role, 'manage the account');
  const [keys, setKeys] = useState<StorageKey[] | null>(null);
  const [names, setNames] = useState<{ buckets: string[]; queues: string[]; functions: string[] }>({ buckets: [], queues: [], functions: [] });
  const [made, setMade] = useState<CreatedStorageKey | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setKeys((await storageKeysApi.list()).data);
      setError(null);
    } catch (failure) {
      setError(apiErrorMessage(failure));
    }
  }, []);
  const accountId = account?.id;
  useEffect(() => {
    if (!accountId || !owner) return;
    void load();
    let current = true;
    // What the form offers to pick: a list that can't be read offers none.
    const namesOf = (read: () => Promise<{ data: Array<{ name: string }> }>) => read().then(({ data }) => data.map((each) => each.name), () => []);
    void Promise.all([namesOf(bucketsApi.list), namesOf(queuesApi.list), namesOf(functionsApi.getAllFunctions)]).then(([buckets, queues, functions]) => {
      if (current) setNames({ buckets, queues, functions });
    });
    return () => {
      current = false;
    };
  }, [accountId, owner, load]);

  if (!account) return null;
  const limit = account.plan.limits.accessKeys;
  const open = account.status === 'active' && !account.storageDisabledAt;
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (failure) {
      setError(apiErrorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const make = (draft: KeyDraft) => void act(async () => setMade((await storageKeysApi.create(requestOf(draft))).data));

  return (
    <Page>
      <PageHeader
        title="Access keys"
        description="AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for AWS's SDKs and CLI, as an IAM user's keys: the account's buckets, queues and mail at FF's endpoints, and the functions a key names. A key stays as it was made; for another reach, make another and revoke the old one."
      />
      {!owner ? (
        <Callout tone="neutral">Only the account's owners see, make and revoke its access keys, as they do its API keys.</Callout>
      ) : (
        <>
          {account.storageDisabledAt && (
            <Callout tone="danger" role="alert" title="FF turned this account's buckets and queues off" className="mb-6">
              {account.storageDisabledReason} Its keys are refused until FF turns them on again.
            </Callout>
          )}
          {made && <KeyOnce made={made} command={tryCommand(made, names.buckets[0])} onDone={() => setMade(null)} />}
          {error && (
            <p role="alert" className="mb-4 text-red-700">
              {error}
            </p>
          )}
          <Panel
            title="The account's keys"
            description={keys ? `${keys.length} of the ${account.plan.name} plan's ${limit}. A function's own key and a site deploy's aren't among them.` : undefined}
            flush
            className="mb-6"
            aria-label="The account's access keys"
          >
            {keys === null ? (
              !error && <p className="px-4 py-10 text-center text-gray-500">Loading…</p>
            ) : keys.length === 0 ? (
              <p className="px-5 py-8 text-center text-gray-600">No access key yet: make one below.</p>
            ) : (
              <div className="relative overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-gray-50/70 text-xs text-gray-500">
                    <tr className="border-b border-line">
                      <th scope="col" className="px-3.5 py-2.5 font-medium">Name</th>
                      <th scope="col" className="px-3.5 py-2.5 font-medium">It reaches</th>
                      <th scope="col" className="hidden px-3.5 py-2.5 font-medium md:table-cell">Last used</th>
                      <th scope="col" className="hidden px-3.5 py-2.5 font-medium lg:table-cell">Made</th>
                      <th scope="col" className="px-3.5 py-2.5">
                        <span className="sr-only">Revoke</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {keys.map((key) => (
                      <tr key={key.id} className="align-top">
                        <td className="px-3.5 py-3">
                          <div className="font-semibold text-ink break-all">{key.name}</div>
                          {key.name !== key.id && <code className="font-mono text-xs text-gray-500">{key.id}</code>}
                        </td>
                        <td className="px-3.5 py-3 text-[13px] text-gray-700">{keyReach(key)}</td>
                        <td className="hidden px-3.5 py-3 whitespace-nowrap text-[13px] text-gray-600 md:table-cell">{key.lastUsedAt ? formatWhen(key.lastUsedAt) : 'never'}</td>
                        <td className="hidden px-3.5 py-3 whitespace-nowrap text-[13px] text-gray-600 lg:table-cell">{formatWhen(key.createdAt)}</td>
                        <td className="px-3.5 py-3 text-right">
                          {revoking === key.id ? (
                            <span role="alertdialog" aria-label={`Revoke ${key.name}`} className="inline-flex flex-wrap items-center justify-end gap-2">
                              <span className="text-[13px] text-gray-700">Whatever uses it stops at once.</span>
                              <button
                                type="button"
                                className="btn btn-primary"
                                disabled={busy}
                                onClick={() =>
                                  void act(async () => {
                                    await storageKeysApi.revoke(key.id);
                                    setRevoking(null);
                                  })
                                }
                              >
                                Revoke
                              </button>
                              <button type="button" className="btn btn-secondary" onClick={() => setRevoking(null)}>
                                Keep it
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setRevoking(key.id)}
                              aria-label={`Revoke ${key.name}`}
                              className="rounded-md px-2 py-1 text-[13px] font-medium text-gray-500 hover:bg-red-50 hover:text-red-700"
                            >
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          {open && keys !== null && keys.length < limit && (
            <Panel title="New access key" description="What it reaches is said below as the list will say it.">
              <NewKeyForm key={keys.length} names={names} busy={busy} onMake={make} />
            </Panel>
          )}
          {open && keys !== null && keys.length >= limit && (
            <Callout tone="info">
              The account has the {limit} keys its plan allows: revoke one to make another. <Link to="/account">Its plan</Link> says what else it allows.
            </Callout>
          )}
        </>
      )}
    </Page>
  );
};

export default AccessKeys;
