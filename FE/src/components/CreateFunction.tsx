import React, { useState } from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { createFunction } from '../store/functionSlice';
import { AppDispatch } from '../store/store';
export enum Runtime {
  NODEJS = 'nodejs',
  PYTHON = 'python',
}
const CreateFunction: React.FC = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  
  const [formData, setFormData] = useState({
    name: '',
    // description: '',
    code: '',
    runtime : Runtime.NODEJS,
    memory : 128,
    timeout : 5,
    metadata : {}
  });
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await dispatch(createFunction(formData)).unwrap();
      navigate('/functions');
    } catch (err: any) {
      setError(err.message);
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

        {/* <div>
          <label className="block text-sm font-medium text-gray-700">
            Description
          </label>
          <textarea
            value={formData.description}
            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            className="input mt-1"
            rows={3}
            required
          />
        </div> */}

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
            <option value={Runtime.NODEJS}>Node.js</option>
            <option value={Runtime.PYTHON}>Python</option>
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

        {/* <div>
          <label className="block text-sm font-medium text-gray-700">
            Metadata
          </label>
          <input
            type="text"
            value={formData.metadata}
            onChange={(e) => setFormData({ ...formData, metadata: e.target.value })}
            className="input mt-1"
          />
        </div> */}

        <div className="flex gap-4">
          <button
            type="submit"
            className="btn btn-primary"
          >
            Create Function
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
