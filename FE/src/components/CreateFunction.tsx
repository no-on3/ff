import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { CreateFailure, FUNCTION_NAME_PATTERN, FUNCTION_NAME_RULE, MAX_FUNCTION_NAME_LENGTH, apiErrorMessage } from '../lib/functions';
import { NewFunction, Runtime } from '../services/api';
import { can } from '../lib/session';
import { useSession } from '../session/session';
import { createFunction } from '../store/functionSlice';
import { AppDispatch } from '../store/store';
import { Page, PageHeader } from './Page';
import { Callout, Panel } from './Panel';

const CreateFunction: React.FC = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  const { plan, role } = useSession().account!; // the function pages show only for an account

  const [formData, setFormData] = useState<NewFunction>({
    name: '',
    code: '',
    runtime: 'nodejs',
    memory: 128,
    timeout: 5,
    metadata: {},
  });
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await dispatch(createFunction(formData)).unwrap();
      navigate('/functions');
    } catch (err) {
      // The API's reason: a validation error, or why the function didn't become ready. In the
      // second case the function exists, ERROR: its page says why, and the form there fixes it.
      const failure = err as Partial<CreateFailure>;
      if (failure.functionId) {
        navigate(`/functions/${failure.functionId}`);
        return;
      }
      setError(failure.message ?? apiErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  if (!can(role, 'change functions')) {
    return (
      <div className="page">
        <div className="card">As a viewer, you read this account's functions; owners and developers create them.</div>
      </div>
    );
  }

  return (
    <Page>
      <PageHeader
        crumbs={[{ label: 'Functions', to: '/functions' }]}
        title="Create a function"
        description={
          <>
            Write its code here, or deploy a folder with its libraries from your terminal with <code className="font-mono text-[13px]">ff deploy</code>.
          </>
        }
      />

      <div className="max-w-3xl">
        {error && (
          <Callout tone="danger" role="alert" className="mb-4">
            {error}
          </Callout>
        )}

        <Panel>
          <form onSubmit={handleSubmit} className="space-y-5">
            <label className="block">
              <span className="text-[13px] font-medium text-gray-700">Name</span>
              <input
                type="text"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                className="input mt-1"
                maxLength={MAX_FUNCTION_NAME_LENGTH}
                pattern={FUNCTION_NAME_PATTERN}
                title={FUNCTION_NAME_RULE}
                required
              />
              <span className="mt-1 block text-xs text-gray-500">{FUNCTION_NAME_RULE}, unique in this account.</span>
            </label>

            <label className="block">
              <span className="text-[13px] font-medium text-gray-700">Code</span>
              <textarea
                value={formData.code}
                onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                className="input mt-1 font-mono text-[13px] leading-5"
                rows={14}
                spellCheck={false}
                required
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="text-[13px] font-medium text-gray-700">Runtime</span>
                <select
                  value={formData.runtime}
                  onChange={(e) => setFormData({ ...formData, runtime: e.target.value as Runtime })}
                  className="select mt-1 w-full"
                  required
                >
                  <option value="nodejs">Node.js</option>
                  <option value="python">Python</option>
                </select>
              </label>
              <label className="block">
                <span className="text-[13px] font-medium text-gray-700">Memory (MB)</span>
                <input
                  type="number"
                  min={128}
                  max={plan.limits.memoryMb}
                  value={formData.memory}
                  onChange={(e) => setFormData({ ...formData, memory: parseInt(e.target.value) })}
                  className="input mt-1"
                  required
                />
                <span className="mt-1 block text-xs text-gray-500">
                  128 to {plan.limits.memoryMb} MB on the {plan.name} plan.
                </span>
              </label>
              <label className="block">
                <span className="text-[13px] font-medium text-gray-700">Timeout (s)</span>
                <input
                  type="number"
                  min={1}
                  max={plan.limits.timeoutSeconds}
                  value={formData.timeout}
                  onChange={(e) => setFormData({ ...formData, timeout: parseInt(e.target.value) })}
                  className="input mt-1"
                  required
                />
                <span className="mt-1 block text-xs text-gray-500">
                  1 to {plan.limits.timeoutSeconds} s on the {plan.name} plan.
                </span>
              </label>
            </div>

            <div className="flex gap-3 border-t border-line pt-4">
              <button type="submit" className="btn btn-primary" disabled={creating}>
                {creating ? 'Creating… (waits until it runs)' : 'Create function'}
              </button>
              <button type="button" onClick={() => navigate('/functions')} className="btn btn-secondary">
                Cancel
              </button>
            </div>
          </form>
        </Panel>
      </div>
    </Page>
  );
};

export default CreateFunction;
