import React, { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage } from '../lib/functions';
import type { FunctionUrl } from '../lib/function-url';
import {
  AliasForm,
  FunctionAlias,
  FunctionVersion,
  LATEST,
  aliasBody,
  aliasFormOf,
  aliasesOn,
  emptyAliasForm,
  rollbackBody,
  rollbackTarget,
  routeText,
  shortSha,
} from '../lib/versions';
import { Function, aliasesApi, functionUrlApi, versionsApi } from '../services/api';
import { Callout, Panel } from './Panel';
import StatusPill from './StatusPill';

/** What waits for a second click: a version's or an alias's deletion, or an alias pointed back. */
type Pending = { kind: 'version'; version: string } | { kind: 'alias'; name: string } | { kind: 'rollback'; name: string; target: string };

const field = 'flex flex-col gap-1 text-[13px] text-gray-700';

/**
 * A function's versions and aliases, as AWS Lambda's: a version is the
 * function as it was published, which never changes; an alias a name for one,
 * or for $LATEST, which its URL, its schedules and the queues it reads follow
 * when it is pointed elsewhere. Every member sees them; owners and developers
 * publish, point an alias, roll it back in one move, and delete.
 */
export const FunctionVersions: React.FC<{ func: Function; mayChange: boolean }> = ({ func, mayChange }) => {
  const [versions, setVersions] = useState<FunctionVersion[] | undefined>(undefined);
  const [aliases, setAliases] = useState<FunctionAlias[]>([]);
  const [urls, setUrls] = useState<FunctionUrl[]>([]);
  /** The new version's description as typed; null while no version is being published. */
  const [publishing, setPublishing] = useState<string | null>(null);
  /** The alias being changed, 'new' for one being made, null for none. */
  const [editing, setEditing] = useState<FunctionAlias | 'new' | null>(null);
  const [form, setForm] = useState<AliasForm>(emptyAliasForm([]));
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [listedVersions, listedAliases, listedUrls] = await Promise.all([versionsApi.list(func.id), aliasesApi.list(func.id), functionUrlApi.list(func.id)]);
      setVersions(listedVersions.data);
      setAliases(listedAliases.data);
      setUrls(listedUrls.data);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [func.id]);
  useEffect(() => {
    void load();
  }, [load]);

  /** A call, then the lists as the API has them; the API's refusal said, in its words. */
  const run = async (call: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const said = await call();
      if (said) setNotice(said);
      setPublishing(null);
      setEditing(null);
      setPending(null);
      await load();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const publish = (event: React.FormEvent) => {
    event.preventDefault();
    const before = new Set((versions ?? []).map((version) => version.version));
    void run(async () => {
      const { data } = await versionsApi.publish(func.id, (publishing ?? '').trim());
      return before.has(data.version)
        ? `Nothing but the description changed since version ${data.version}: it is that version, as on Lambda.`
        : `Version ${data.version} published: the function as it is now, which never changes.`;
    });
  };

  const openAlias = (alias: FunctionAlias | 'new') => {
    setForm(alias === 'new' ? emptyAliasForm(versions ?? []) : aliasFormOf(alias));
    setError(null);
    setNotice(null);
    setPending(null);
    setEditing(alias);
  };

  const saveAlias = (event: React.FormEvent) => {
    event.preventDefault();
    const built = aliasBody(form, editing === 'new');
    if ('problem' in built) return setError(built.problem);
    if (editing === 'new') void run(() => aliasesApi.create(func.id, built.body).then(() => undefined));
    else if (editing) void run(() => aliasesApi.update(func.id, editing.name, { ...built.body, revisionId: editing.revisionId }).then(() => undefined));
  };

  const confirm = (question: string, action: string, call: () => Promise<unknown>) => (
    <>
      <span className="self-center text-[13px] text-gray-700">{question}</span>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => call().then(() => undefined))}>
        {action}
      </button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPending(null)}>
        Cancel
      </button>
    </>
  );

  const newestFirst = [...(versions ?? [])].sort((a, b) => Number(b.version) - Number(a.version));
  const idle = mayChange && editing === null && publishing === null;

  return (
    <div className="space-y-6">
      {error && (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      )}
      {notice && (
        <Callout tone="info" role="status">
          {notice}
        </Callout>
      )}

      <Panel
        title="Versions"
        description="Each version is the function as it was published, its code, its settings and its variables, and never changes, as AWS Lambda's. The function itself keeps changing as $LATEST."
        actions={
          idle && versions !== undefined ? (
            <button type="button" className="btn btn-secondary" onClick={() => setPublishing('')}>
              Publish a version
            </button>
          ) : undefined
        }
      >
        {publishing !== null && (
          <form onSubmit={publish} className="mb-4 flex flex-wrap items-end gap-3" aria-label="A version to publish">
            <label className={`${field} min-w-0 flex-1`}>
              Description (optional)
              <input className="input" value={publishing} maxLength={256} placeholder="What changed, such as the new checkout" onChange={(e) => setPublishing(e.target.value)} />
            </label>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Publishing…' : 'Publish'}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPublishing(null)}>
              Cancel
            </button>
          </form>
        )}
        {versions === undefined && !error && <p className="text-[13px] text-gray-500">Loading…</p>}
        {versions?.length === 0 && <p className="text-[13px] text-gray-600">No version yet: publish one to freeze the function as it is, then point an alias at it.</p>}
        {newestFirst.length > 0 && (
          <ul className="divide-y divide-gray-100" aria-label="Its versions">
            {newestFirst.map((version) => {
              const reaching = aliasesOn(version.version, aliases);
              const named = reaching.map((alias) => alias.name);
              return (
                <li key={version.version} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <span className="font-semibold text-ink">Version {version.version}</span>
                  <span className="text-[13px] text-gray-600 tabular-nums">{new Date(version.createdAt).toLocaleString()}</span>
                  <span className="text-[13px] text-gray-600">
                    {version.runtime}, {version.memory} MB, {version.timeout} s
                  </span>
                  <code className="font-mono text-[12px] text-gray-600" title={`Its code's SHA-256: ${version.codeSha256}`}>
                    {shortSha(version.codeSha256)}
                  </code>
                  {reaching.map((alias) => (
                    <StatusPill key={alias.name} tone="ok" label={alias.label} title={`The alias ${alias.name} sends calls to it`} />
                  ))}
                  {version.description && <span className="basis-full text-[13px] text-gray-700">{version.description}</span>}
                  {idle && (
                    <span className="ml-auto flex flex-wrap gap-2">
                      {pending?.kind === 'version' && pending.version === version.version ? (
                        confirm(`Delete version ${version.version}? Its number is never given again.`, 'Delete', () => versionsApi.remove(func.id, version.version))
                      ) : (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          disabled={named.length > 0}
                          title={named.length > 0 ? `${named.join(', ')} ${named.length === 1 ? 'names' : 'name'} it: point ${named.length === 1 ? 'it' : 'them'} elsewhere first` : undefined}
                          onClick={() => setPending({ kind: 'version', version: version.version })}
                        >
                          Delete
                        </button>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="Aliases"
        description="An alias names a version, or $LATEST, as Lambda's: its URL, its schedules and the queues it reads follow it when it is pointed at another. A second version may take a share of its calls, to try it on some of them first."
        actions={
          idle && versions !== undefined ? (
            <button type="button" className="btn btn-secondary" onClick={() => openAlias('new')}>
              Make an alias
            </button>
          ) : undefined
        }
      >
        {versions !== undefined && aliases.length === 0 && editing === null && <p className="text-[13px] text-gray-600">No alias yet.</p>}
        {aliases.length > 0 && (
          <ul className="divide-y divide-gray-100" aria-label="Its aliases">
            {aliases.map((alias) => {
              const url = urls.find((candidate) => candidate.alias === alias.name)?.functionUrl;
              const target = rollbackTarget(alias, versions ?? []);
              return (
                <li key={alias.name} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
                  <span className="font-semibold text-ink">{alias.name}</span>
                  <span className="text-[13px] text-gray-700">{routeText(alias)}</span>
                  {url && (
                    <a href={url} target="_blank" rel="noreferrer" className="font-mono text-[12px] break-all text-ink hover:underline">
                      {url}
                    </a>
                  )}
                  {alias.description && <span className="basis-full text-[13px] text-gray-600">{alias.description}</span>}
                  {idle && (
                    <span className="ml-auto flex flex-wrap gap-2">
                      {pending?.kind === 'alias' && pending.name === alias.name ? (
                        confirm(
                          `Delete ${alias.name}?${url ? " Its URL and the URL's domains go with it." : ''} What names it stops until an alias of that name is made again.`,
                          'Delete',
                          () => aliasesApi.remove(func.id, alias.name),
                        )
                      ) : pending?.kind === 'rollback' && pending.name === alias.name ? (
                        confirm(`Send every call of ${alias.name} to version ${pending.target}?`, 'Roll back', () =>
                          aliasesApi.update(func.id, alias.name, rollbackBody(alias, pending.target)),
                        )
                      ) : (
                        <>
                          {target && (
                            <button type="button" className="btn btn-secondary" onClick={() => setPending({ kind: 'rollback', name: alias.name, target })}>
                              Roll back to version {target}
                            </button>
                          )}
                          <button type="button" className="btn btn-secondary" onClick={() => openAlias(alias)}>
                            Change
                          </button>
                          <button type="button" className="btn btn-secondary" onClick={() => setPending({ kind: 'alias', name: alias.name })}>
                            Delete
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {editing !== null && (
          <form onSubmit={saveAlias} className="mt-2 space-y-4" aria-label={editing === 'new' ? 'A new alias' : `Where ${editing.name} points`}>
            <div className="grid gap-4 sm:grid-cols-2">
              {editing === 'new' ? (
                <label className={field}>
                  Name
                  <input className="input" value={form.name} maxLength={128} spellCheck={false} placeholder="live" onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  <span className="text-xs text-gray-500">Letters, digits, - and _, not digits alone, which name a version</span>
                </label>
              ) : (
                <p className="self-end text-[13px] text-gray-700">
                  The alias <span className="font-semibold">{editing.name}</span>
                </p>
              )}
              <label className={field}>
                Its calls go to
                <select
                  className="input"
                  value={form.version}
                  onChange={(e) => setForm({ ...form, version: e.target.value, ...(e.target.value === LATEST ? { shareVersion: '', sharePercent: '' } : {}) })}
                >
                  {newestFirst.map((version) => (
                    <option key={version.version} value={version.version}>
                      Version {version.version}
                    </option>
                  ))}
                  <option value={LATEST}>$LATEST, the function as it is</option>
                </select>
              </label>
              {form.version !== LATEST && (
                <>
                  <label className={field}>
                    A share of its calls to another version (optional)
                    <select className="input" value={form.shareVersion} onChange={(e) => setForm({ ...form, shareVersion: e.target.value })}>
                      <option value="">None</option>
                      {newestFirst
                        .filter((version) => version.version !== form.version)
                        .map((version) => (
                          <option key={version.version} value={version.version}>
                            Version {version.version}
                          </option>
                        ))}
                    </select>
                  </label>
                  {form.shareVersion !== '' && (
                    <label className={field}>
                      Its share, in percent of the calls
                      <input className="input" type="number" min={0} max={100} step={0.1} value={form.sharePercent} onChange={(e) => setForm({ ...form, sharePercent: e.target.value })} />
                    </label>
                  )}
                </>
              )}
              <label className={`${field} sm:col-span-2`}>
                Description (optional)
                <input className="input" value={form.description} maxLength={256} onChange={(e) => setForm({ ...form, description: e.target.value })} />
              </label>
            </div>
            <div className="flex flex-wrap gap-3">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? 'Saving…' : editing === 'new' ? 'Make it' : 'Save'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </Panel>
    </div>
  );
};
