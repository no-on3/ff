import React, { useCallback, useEffect, useState } from 'react';
import { plansApi } from '../api';
import ReasonDialog from '../components/ReasonDialog';
import { ErrorState, Loading } from '../components/States';
import { apiErrorMessage, notAnOperator } from '../lib/errors';
import { LIMIT_FIELDS, Plan, PlanLimits, formOfLimits, limitChanges, limitsOfForm, quotaLabel } from '../lib/plans';

/** What the form is for: an existing plan, or a new one from a plan's limits. */
type Editing = { kind: 'edit'; plan: Plan } | { kind: 'new'; from: Plan };

/**
 * Plans and their limits (P-73, D5): every account is on one. A change
 * applies at once, and a new quota goes to every account on the plan; a new
 * plan starts from another's limits.
 */
const Plans: React.FC<{ email: string | undefined }> = ({ email }) => {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [identity, setIdentity] = useState({ id: '', name: '' });
  const [problems, setProblems] = useState<string[]>([]);
  const [pending, setPending] = useState<{ limits: PlanLimits; changes: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    plansApi.list().then(
      ({ data }) => setPlans(data),
      (error) => (notAnOperator(error) ? setRefused(true) : setFailure(apiErrorMessage(error))),
    );
  }, []);
  useEffect(load, [load]);

  if (refused) return <ErrorState message={`You are logged in as ${email ?? 'someone'}, who isn't one of FF's operators.`} />;
  if (failure) return <ErrorState message={failure} />;
  if (!plans) return <Loading />;

  const open = (next: Editing) => {
    setNotice(null);
    setProblems([]);
    setEditing(next);
    const plan = next.kind === 'edit' ? next.plan : next.from;
    setForm(formOfLimits(plan.limits));
    setIdentity(next.kind === 'edit' ? { id: plan.id, name: plan.name } : { id: '', name: '' });
  };
  const review = (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const read = limitsOfForm(form);
    if ('problems' in read) return setProblems(read.problems);
    const base = editing.kind === 'edit' ? editing.plan : editing.from;
    const changes = editing.kind === 'edit' ? limitChanges(base.limits, read.limits) : [];
    if (editing.kind === 'edit' && identity.name !== base.name) changes.unshift(`Name: ${base.name} → ${identity.name}`);
    if (editing.kind === 'edit' && changes.length === 0) return setProblems(['Nothing changes.']);
    if (editing.kind === 'new' && !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(identity.id)) return setProblems(['ID: lowercase letters, digits, - and _, such as pro']);
    if (editing.kind === 'new' && !identity.name.trim()) return setProblems(['Name: give the plan a name']);
    setProblems([]);
    setPending({ limits: read.limits, changes });
  };
  const confirm = async (reason: string) => {
    if (!editing || !pending) return;
    try {
      if (editing.kind === 'edit') {
        const { data } = await plansApi.update(editing.plan.id, { name: identity.name, limits: pending.limits }, reason);
        const { applied, failed } = data.quota;
        setNotice(
          applied + failed === 0
            ? `Saved: ${data.plan.name} applies at once.`
            : `Saved: the new quota went to ${applied} account${applied === 1 ? '' : 's'}${failed ? `; ${failed} couldn't take it, and get it at their next deploy` : ''}.`,
        );
      } else {
        const { data } = await plansApi.create({ id: identity.id, name: identity.name.trim(), limits: pending.limits }, reason);
        setNotice(`Created ${data.name} (${data.id}): accounts can be moved to it from their page.`);
      }
      setPending(null);
      setEditing(null);
      load();
    } catch (error) {
      throw new Error(apiErrorMessage(error));
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Plans</h1>
        <p className="text-gray-600">
          Each account is on a plan, which sets its limits (D5). A change applies at once, and a new quota goes to every account on the plan.
        </p>
      </div>
      {notice && (
        <p role="status" className="rounded bg-green-50 px-3 py-2 text-green-900">
          {notice}
        </p>
      )}

      <div className="card overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600">
            <tr>
              {['Plan', 'Functions', 'Memory', 'Timeout', 'Quota', 'Invocations', 'Egress', ''].map((label) => (
                <th key={label} className="px-4 py-2 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={plan.id} className="border-t border-gray-200 align-top">
                <td className="px-4 py-2">
                  {plan.name} <span className="font-mono text-xs text-gray-500">{plan.id}</span>
                </td>
                <td className="px-4 py-2">{plan.limits.functions}</td>
                <td className="px-4 py-2 whitespace-nowrap">{plan.limits.memoryMb} MB</td>
                <td className="px-4 py-2">{plan.limits.timeoutSeconds} s</td>
                <td className="px-4 py-2">{quotaLabel(plan.limits.quota)}</td>
                <td className="px-4 py-2 whitespace-nowrap">{plan.limits.invokesPerSecond} / s</td>
                <td className="px-4 py-2">{plan.limits.internetEgress ? 'On' : 'Off'}</td>
                <td className="px-4 py-2 whitespace-nowrap">
                  <button type="button" className="text-blue-700 hover:underline" onClick={() => open({ kind: 'edit', plan })}>
                    Edit
                  </button>
                  <button type="button" className="ml-4 text-blue-700 hover:underline" onClick={() => open({ kind: 'new', from: plan })}>
                    New plan from it
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && (
        <form onSubmit={review} className="card space-y-4">
          <h2 className="text-lg font-semibold">{editing.kind === 'edit' ? `Edit ${editing.plan.name}` : `A new plan, from ${editing.from.name}'s limits`}</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {editing.kind === 'new' && (
              <label htmlFor="planId" className="block text-sm">
                <span className="block text-gray-600">ID</span>
                <input id="planId" className="input max-w-xs font-mono" value={identity.id} onChange={(e) => setIdentity({ ...identity, id: e.target.value })} />
              </label>
            )}
            <label htmlFor="planName" className="block text-sm">
              <span className="block text-gray-600">Name</span>
              <input id="planName" className="input max-w-xs" value={identity.name} onChange={(e) => setIdentity({ ...identity, name: e.target.value })} />
            </label>
            {LIMIT_FIELDS.map(({ path, label, unit, kind }) => {
              const name = path.join('.');
              return (
                <label key={name} htmlFor={name} className="block text-sm">
                  <span className="block text-gray-600">{label}</span>
                  <span className="flex items-center gap-2">
                    {kind === 'boolean' ? (
                      <select id={name} className="input max-w-xs" value={form[name]} onChange={(e) => setForm({ ...form, [name]: e.target.value })}>
                        <option value="true">On</option>
                        <option value="false">Off</option>
                      </select>
                    ) : (
                      <input id={name} className="input max-w-xs" value={form[name] ?? ''} onChange={(e) => setForm({ ...form, [name]: e.target.value })} />
                    )}
                    {unit && <span className="text-gray-500">{unit}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          {problems.length > 0 && (
            <ul role="alert" className="list-disc space-y-1 pl-5 text-sm text-red-700">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn btn-primary">
              {editing.kind === 'edit' ? 'Review the changes' : 'Create…'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {pending && editing && (
        <ReasonDialog
          title={editing.kind === 'edit' ? `Change ${editing.plan.name}?` : `Create ${identity.name.trim()}?`}
          confirmLabel={editing.kind === 'edit' ? 'Save' : 'Create'}
          onConfirm={confirm}
          onCancel={() => setPending(null)}
        >
          {editing.kind === 'edit' ? (
            <ul className="list-disc space-y-1 pl-5">
              {pending.changes.map((change) => (
                <li key={change}>{change}</li>
              ))}
            </ul>
          ) : (
            <p>
              {identity.id}, with {editing.from.name}'s limits as set here. Accounts can be moved to it from their page.
            </p>
          )}
        </ReasonDialog>
      )}
    </div>
  );
};

export default Plans;
