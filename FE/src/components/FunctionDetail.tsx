import React, { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import { useNavigate, useParams } from 'react-router-dom';
import { FunctionInvocation, functionsApi } from '../services/api';
import { updateFunction } from '../store/functionSlice';
import { AppDispatch } from '../store/store';
import { Tabs, Tab, Box } from '@mui/material';
import { MetricsDashboard } from './MetricsDashboard';
import { ScalingConfiguration } from './ScalingConfiguration';

const FunctionDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const dispatch = useDispatch<AppDispatch>();
  
  const [func, setFunc] = useState<any>(null);
  const [invocations, setInvocations] = useState<FunctionInvocation[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState(0);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [funcResponse, invocationsResponse] = await Promise.all([
          functionsApi.getFunction(id!),
          functionsApi.getFunctionInvocations(id!)
        ]);
        console.log({funcResponse, invocationsResponse})
        setFunc(funcResponse.data);
        setInvocations(invocationsResponse.data);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    if (id) {
      fetchData();
    }
  }, [id]);

  const handleInvoke = async () => {
    try {
      setLoading(true);
      let parsedInput;
      try {
        parsedInput = JSON.parse(input);
      } catch (err) {
        setError('Invalid JSON input');
        setLoading(false);
        return;
      }

      // Send input data directly
      const response = await functionsApi.invokeFunction(id!, { input: parsedInput });
      
      // Add the new invocation to the list
      const newInvocation: FunctionInvocation = {
        id: response.data.id,
        functionId: id!,
        input: parsedInput,
        output: response.data.output,
        status: response.data.status,
        memoryUsed: response.data.metrics?.memoryUsed,
        cpuUsed: response.data.metrics?.cpuUsed,
        duration: response.data.metrics?.duration,
        createdAt: response.data.metrics?.startTime,
        updatedAt: response.data.metrics?.endTime,
        error: response.data.error
      };

      setInvocations(prev => Array.isArray(prev) ? [newInvocation, ...prev] : [newInvocation]);
      setInput(''); // Clear input after successful invocation
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdate = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      await dispatch(updateFunction({ id: id!, data: func })).unwrap();
      navigate('/functions');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleTabChange = (_event: React.SyntheticEvent, newValue: number) => {
    setActiveTab(newValue);
  };

  if (loading) {
    return <div className="flex justify-center items-center h-64">Loading...</div>;
  }

  if (error) {
    return <div className="text-red-600 p-4">{error}</div>;
  }

  if (!func) {
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
          <h1 className="text-2xl font-bold mb-4">{func.name}</h1>
          
          <form onSubmit={handleUpdate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Name</label>
              <input
                type="text"
                value={func.name}
                onChange={(e) => setFunc({ ...func, name: e.target.value })}
                className="input mt-1"
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700">Description</label>
              <textarea
                value={func.description}
                onChange={(e) => setFunc({ ...func, description: e.target.value })}
                className="input mt-1"
                rows={3}
              />
            </div>
            
            <div>
              <label className="block text-sm font-medium text-gray-700">Code</label>
              <textarea
                value={func.code}
                onChange={(e) => setFunc({ ...func, code: e.target.value })}
                className="input mt-1 font-mono"
                rows={10}
              />
            </div>
            
            <button type="submit" className="btn btn-primary">
              Update Function
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
              placeholder="Enter JSON input..."
              className="input flex-grow font-mono"
              rows={3}
            />
            <button
              onClick={handleInvoke}
              disabled={loading}
              className="btn btn-primary self-start"
            >
              Invoke
            </button>
          </div>

          <div className="mt-12">
            <h2 className="text-xl font-bold mb-4">Invocation History</h2>
            <div className="space-y-4">
              {invocations && invocations.length > 0 && invocations.map((invocation) => (
                <div key={invocation.id} className="card">
                  <div className="flex justify-between items-start mb-4">
                    <span className="text-sm text-gray-500">
                      {new Date(invocation.createdAt).toLocaleString()}
                    </span>
                    <span
                      className={`px-2 py-1 rounded-full text-sm ${
                        invocation.status === 'COMPLETED'
                          ? 'bg-green-100 text-green-800'
                          : invocation.status === 'RUNNING'
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-red-100 text-red-800'
                      }`}
                    >
                      {invocation.status}
                    </span>
                  </div>
                  
                  {/* Results and Metrics Box */}
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div className="space-y-2">
                      <div>
                        <h3 className="text-sm font-medium text-gray-700">Input:</h3>
                        <pre className="bg-gray-50 p-2 rounded mt-1 text-sm">
                          {JSON.stringify(invocation.input, null, 2)}
                        </pre>
                      </div>
                      <div>
                        <h3 className="text-sm font-medium text-gray-700">Output:</h3>
                        <pre className="bg-gray-50 p-2 rounded mt-1 text-sm">
                          {JSON.stringify(invocation.output, null, 2)}
                        </pre>
                      </div>
                    </div>
                    
                    <div className="bg-gray-50 rounded-lg p-4">
                      <h3 className="text-sm font-medium text-gray-700 mb-3">Metrics:</h3>
                      <div className="space-y-2">
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-600">Memory Used:</span>
                          <span className="text-sm font-medium">
                            {invocation.memoryUsed ? `${(invocation.memoryUsed / 1024 / 1024).toFixed(2)} MB` : 'N/A'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-600">CPU Used:</span>
                          <span className="text-sm font-medium">
                            {invocation.cpuUsed ? `${(invocation.cpuUsed * 100).toFixed(1)}%` : 'N/A'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-600">Duration:</span>
                          <span className="text-sm font-medium">
                            {invocation.duration ? `${invocation.duration.toFixed(2)}ms` : 'N/A'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-600">Start Time:</span>
                          <span className="text-sm font-medium">
                            {invocation.createdAt ? new Date(invocation.createdAt).toLocaleTimeString() : 'N/A'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-sm text-gray-600">End Time:</span>
                          <span className="text-sm font-medium">
                            {invocation.updatedAt ? new Date(invocation.updatedAt).toLocaleTimeString() : 'N/A'}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                  
                  {invocation.error && (
                    <div className="mt-2">
                      <h3 className="text-sm font-medium text-red-700">Error:</h3>
                      <pre className="bg-red-50 text-red-700 p-2 rounded mt-1 text-sm">
                        {invocation.error}
                      </pre>
                    </div>
                  )}
                </div>
              ))}
              
              {invocations.length === 0 && (
                <div className="text-center text-gray-500">
                  No invocations yet. Try invoking the function!
                </div>
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
