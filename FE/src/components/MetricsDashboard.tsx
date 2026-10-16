import React, { useEffect, useState } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { Card, Grid, Typography, Box, CircularProgress } from '@mui/material';
import { format } from 'date-fns';
import { getMetrics } from '../services/api';

interface MetricsDashboardProps {
  functionId: string;
}

export const MetricsDashboard: React.FC<MetricsDashboardProps> = ({ functionId }) => {
  const [metrics, setMetrics] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        setLoading(true);
        const end = new Date();
        const start = new Date(end.getTime() - 3600000); // Last hour
        const data = await getMetrics(functionId, start, end);
        
        // Format data for charts
        const formattedData = data.map((m: any) => ({
          ...m,
          timestamp: format(new Date(m.timestamp), 'HH:mm:ss'),
        }));
        
        setMetrics(formattedData);
      } catch (error) {
        console.error('Error fetching metrics:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchMetrics();
    const interval = setInterval(fetchMetrics, 60000); // Refresh every minute
    return () => clearInterval(interval);
  }, [functionId]);

  if (loading) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="400px">
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Grid container spacing={3}>
      <Grid item xs={12}>
        <Typography variant="h6" gutterBottom>
          Function Metrics Dashboard
        </Typography>
      </Grid>

      {/* Request Rate Chart */}
      <Grid item xs={12} md={6}>
        <Card>
          <Box p={2}>
            <Typography variant="subtitle1" gutterBottom>
              Request Rate
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={metrics}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="timestamp" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="requestCount"
                  stroke="#8884d8"
                  name="Requests"
                />
                <Line
                  type="monotone"
                  dataKey="errorCount"
                  stroke="#ff0000"
                  name="Errors"
                />
              </LineChart>
            </ResponsiveContainer>
          </Box>
        </Card>
      </Grid>

      {/* Resource Usage Chart */}
      <Grid item xs={12} md={6}>
        <Card>
          <Box p={2}>
            <Typography variant="subtitle1" gutterBottom>
              Resource Usage
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={metrics}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="timestamp" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="cpuUsage"
                  stroke="#82ca9d"
                  name="CPU Usage (%)"
                />
                <Line
                  type="monotone"
                  dataKey="memoryUsage"
                  stroke="#ffc658"
                  name="Memory Usage (MB)"
                />
              </LineChart>
            </ResponsiveContainer>
          </Box>
        </Card>
      </Grid>

      {/* Response Time Chart */}
      <Grid item xs={12} md={6}>
        <Card>
          <Box p={2}>
            <Typography variant="subtitle1" gutterBottom>
              Response Times
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={metrics}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="timestamp" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="responseTimeP50"
                  stroke="#8884d8"
                  name="P50 (ms)"
                />
                <Line
                  type="monotone"
                  dataKey="responseTimeP95"
                  stroke="#82ca9d"
                  name="P95 (ms)"
                />
                <Line
                  type="monotone"
                  dataKey="responseTimeP99"
                  stroke="#ffc658"
                  name="P99 (ms)"
                />
              </LineChart>
            </ResponsiveContainer>
          </Box>
        </Card>
      </Grid>

      {/* Instance Count Chart */}
      <Grid item xs={12} md={6}>
        <Card>
          <Box p={2}>
            <Typography variant="subtitle1" gutterBottom>
              Active Instances
            </Typography>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={metrics}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="timestamp" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line
                  type="monotone"
                  dataKey="activeInstances"
                  stroke="#8884d8"
                  name="Instances"
                />
              </LineChart>
            </ResponsiveContainer>
          </Box>
        </Card>
      </Grid>
    </Grid>
  );
};
