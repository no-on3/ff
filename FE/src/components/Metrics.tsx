import React, { useEffect, useState } from 'react';
import { monitoringApi } from '../services/api';

const Metrics: React.FC = () => {
  const [metrics, setMetrics] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        setLoading(true);
        const response = await monitoringApi.getMetrics();
        setMetrics(response.data);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchMetrics();
    // Refresh metrics every 30 seconds
    const interval = setInterval(fetchMetrics, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <div className="flex justify-center items-center h-64">Loading...</div>;
  }

  if (error) {
    return <div className="text-red-600 p-4">{error}</div>;
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">System Metrics</h1>
      <div className="card">
        <pre className="whitespace-pre-wrap font-mono text-sm">
          {metrics}
        </pre>
      </div>
    </div>
  );
};

export default Metrics;
