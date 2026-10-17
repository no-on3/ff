import React, { useCallback, useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate, useParams } from 'react-router-dom';
import { Tabs, Tab, Box } from '@mui/material';
import {
  EditableFields,
  apiErrorMessage,
  changedFields,
  formatDuration,
  formatMemory,
  parseInvokeInput,
} from '../lib/functions';
import { Function, FunctionInvocation, functionsApi } from '../services/api';
import { updateFunction } from '../store/functionSlice';
import { AppDispatch } from '../store/store';
import { MetricsDashboard } from './MetricsDashboard';
import { ScalingConfiguration } from './ScalingConfiguration';

/** How many invocations the history shows, newest first. */
const HISTORY_PAGE = 20;

const STATUS_STYLES: Record<string, string> = {
  ACTIVE: 'bg-green-100 text-green-800',
  COMPLETED: 'bg-green-100 text-green-800',
  CREATING: 'bg-blue-100 text-blue-800',
  RUNNING: 'bg-blue-100 text-blue-800',
};
const statusStyle = (status: string) => STATUS_STYLES[status] ?? 'bg-red-100 text-red-800';

const FunctionDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();

  const [func, setFunc] = useState<Function | null>(null);
  const [form, setForm] = useState<EditableFields | null>(null);
  const [invocations, setInvocations] = useState<FunctionInvocation[]>([]);
  const [total, setTotal] = useState(0);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [invoking, setInvoking] = useState(false);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(0);

  const loadHistory = useCallback(async () => {
    const page = (await functionsApi.getFunctionInvocations(id!, HISTORY_PAGE)).data;
    setInvocations(page.invocations);
    setTotal(page.total);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const load = async () => {
      try {
        setLoading(true);
        const { data } = await functionsApi.getFunction(id);
        setFunc(data);
        setForm({ name: data.name, code: data.code, memory: data.memory, timeout: data.timeout });
        await loadHistory();
      } catch (err) {
        setLoadError(apiErrorMessage(err));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [id, loadHistory]);

  const handleInvoke = async () => {
    const parsed = parseInvokeInput(input);
    if (!parsed.ok) {
      setInvokeError(parsed.error);
      return;
    }
    setInvoking(true);
    setInvokeError(null);
    try {
      const { data } = await functionsApi.invokeFunction(id!, parsed.input);
      setInvocations((previous) => [data, ...previous]);
      setTotal((count) => count + 1);
    } catch (err) {
      // A function's error answers 400 with its message; the failed invocation is in the history.
      setInvokeError(apiErrorMessage(err));
      await loadHistory().catch(() => undefined);
    } finally {
      setInvoking(false);
    }
  };

  const handleUpdate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!func || !form) return;
    const changes = changedFields(func, form);
    // An unchanged ACTIVE function needs nothing; one in ERROR is retried even unchanged.
    if (Object.keys(changes).length === 0 && func.status === 'ACTIVE') {
      navigate('/functions');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await dispatch(updateFunction({ id: func.id, data: changes })).unwrap();
      navigate('/functions');
    } catch (err) {
      setSaveError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
  };

  if (loading) {
    return <div className="flex justify-center items-center h-64">Loading...</div>;
  }

  if (loadError) {
    return <div className="text-red-600 p-4">{loadError}</div>;
  }

  if (!func || !form) {
    return <div className="text-gray-600 p-4">Function not found</div>;
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <Tabs value={activeTab} onChange={handleTabChange}>
        <Tab label="Overview" />
        <Tab label="Invocations" />
        <Tab label="Metrics" />
        <Tab label="Scaling" />
      </Tabs>

      {activeTab === 0 && (
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <h1 className="text-2xl font-bold">{func.name}</h1>
            <span className={`px-2 py-1 rounded-full text-sm ${statusStyle(func.status)}`}>{func.status}</span>
            <span className="text-sm text-gray-500">
              {func.runtime} · {func.memory} MB · {func.timeout} s
            </span>
          </div>

          {func.status === 'ERROR' && func.error && (
            <div className="bg-red-50 border border-red-300 text-red-800 px-4 py-3 rounded mb-4">
              <p className="font-medium">This function can't run:</p>
              <pre className="whitespace-pre-wrap text-sm mt-1">{func.error}</pre>
              <p className="text-sm mt-2">Fix the code and update the function. An update without changes retries the same code.</p>
            </div>
          )}

          {saveError && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">{saveError}</div>
          )}

          <form onSubmit={handleUpdate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="input mt-1"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">Code</label>
              <textarea
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                className="input mt-1 font-mono"
                rows={10}
              />
            </div>

            <div className="flex gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700">Memory (MB)</label>
                <input
                  type="number"
                  min={128}
                  max={1024}
                  value={form.memory}
                  onChange={(e) => setForm({ ...form, memory: Number(e.target.value) })}
                  className="input mt-1"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700">Timeout (s)</label>
                <input
                  type="number"
                  min={1}
                  max={300}
                  value={form.timeout}
                  onChange={(e) => setForm({ ...form, timeout: Number(e.target.value) })}
                  className="input mt-1"
                />
              </div>
            </div>

            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Updating… (waits until the new version is live)' : 'Update Function'}
            </button>
          </form>
        </div>
      )}

      {activeTab === 1 && (
        <div className="mt-12">
          <h2 className="text-xl font-bold mb-4">Invoke Function</h2>
          <div className="flex gap-4">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='JSON object, e.g. {"name": "Tunis"}; empty means {}'
              className="input flex-grow font-mono"
              rows={3}
            />
            <button onClick={handleInvoke} disabled={invoking} className="btn btn-primary self-start">
              {invoking ? 'Invoking…' : 'Invoke'}
            </button>
          </div>
          {invokeError && (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mt-4">{invokeError}</div>
          )}

          <div className="mt-12">
            <h2 className="text-xl font-bold mb-4">
              Invocation History
              {total > invocations.length && (
                <span className="text-sm font-normal text-gray-500"> (the latest {invocations.length} of {total})</span>
              )}
            </h2>
            <div className="space-y-4">
              {invocations.map((invocation) => (
                <div key={invocation.id} className="card">
                  <div className="flex justify-between items-start mb-4">
                    <span className="text-sm text-gray-500">{new Date(invocation.createdAt).toLocaleString()}</span>
                    <span className={`px-2 py-1 rounded-full text-sm ${statusStyle(invocation.status)}`}>
                      {invocation.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="space-y-2">
                      <div>
                        <h3 className="text-sm font-medium text-gray-700">Input:</h3>
                        <pre className="bg-gray-50 p-2 rounded mt-1 text-sm">{JSON.stringify(invocation.input, null, 2)}</pre>
                      </div>
                      <div>
                        <h3 className="text-sm font-medium text-gray-700">Output:</h3>
                        <pre className="bg-gray-50 p-2 rounded mt-1 text-sm">{JSON.stringify(invocation.output, null, 2)}</pre>
                      </div>
                    </div>

                    <div className="bg-gray-50 rounded-lg p-4">
                      <h3 className="text-sm font-medium text-gray-700 mb-3">Metrics:</h3>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-600">Max memory used:</span>
                          <span className="text-sm font-medium">{formatMemory(invocation.memoryUsed)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-600">Duration:</span>
                          <span className="text-sm font-medium">{formatDuration(invocation.duration)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-600">Start Time:</span>
                          <span className="text-sm font-medium">{new Date(invocation.createdAt).toLocaleTimeString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-600">End Time:</span>
                          <span className="text-sm font-medium">{new Date(invocation.updatedAt).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {invocation.error && (
                    <div className="mt-2">
                      <h3 className="text-sm font-medium text-red-700">Error:</h3>
                      <pre className="bg-red-50 text-red-700 p-2 rounded mt-1 text-sm">{invocation.error}</pre>
                    </div>
                  )}
                </div>
              ))}

              {invocations.length === 0 && (
                <div className="text-center text-gray-500">No invocations yet. Try invoking the function!</div>
              )}
            </div>
          </div>
        </div>
      )}

      {activeTab === 2 && (
        <Box p={3}>
          <MetricsDashboard functionId={id!} />
        </Box>
      )}

      {activeTab === 3 && (
        <Box p={3}>
          <ScalingConfiguration functionId={id!} />
        </Box>
      )}
    </div>
  );
};

export default FunctionDetail;
