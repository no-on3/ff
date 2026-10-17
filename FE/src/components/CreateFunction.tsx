import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { apiErrorMessage } from '../lib/functions';
import { NewFunction, Runtime } from '../services/api';
import { createFunction } from '../store/functionSlice';
import { AppDispatch } from '../store/store';

const CreateFunction: React.FC = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();

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
      // The API's reason: a validation error, or why the function didn't become ready.
      setError(apiErrorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Create New Function</h1>

      {error && (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Function Name
          </label>
          <input
            type="text"
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            className="input mt-1"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Code
          </label>
          <textarea
            value={formData.code}
            onChange={(e) => setFormData({ ...formData, code: e.target.value })}
            className="input mt-1 font-mono"
            rows={10}
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Runtime
          </label>
          <select
            value={formData.runtime}
            onChange={(e) => setFormData({ ...formData, runtime: e.target.value as Runtime })}
            className="input mt-1"
            required
          >
            <option value="nodejs">Node.js</option>
            <option value="python">Python</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Memory
          </label>
          <input
            type="number"
            value={formData.memory}
            onChange={(e) => setFormData({ ...formData, memory: parseInt(e.target.value) })}
            className="input mt-1"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Timeout
          </label>
          <input
            type="number"
            value={formData.timeout}
            onChange={(e) => setFormData({ ...formData, timeout: parseInt(e.target.value) })}
            className="input mt-1"
            required
          />
        </div>

        <div className="flex gap-4">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={creating}
          >
            {creating ? 'Creating… (waits until it runs)' : 'Create Function'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/functions')}
            className="btn btn-secondary"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
};

export default CreateFunction;
