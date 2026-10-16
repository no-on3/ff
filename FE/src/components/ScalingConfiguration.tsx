import React, { useState, useEffect } from 'react';
import {
  Card,
  CardContent,
  Typography,
  TextField,
  Button,
  Grid,
  Slider,
  Box,
  Alert,
} from '@mui/material';
import { updateScalingConfig, getScalingConfig } from '../services/api';

interface ScalingConfigurationProps {
  functionId: string;
}

interface ScalingConfig {
  minInstances: number;
  maxInstances: number;
  targetCpuUtilization: number;
  targetMemoryUtilization: number;
  scaleUpThreshold: number;
  scaleDownThreshold: number;
  cooldownPeriod: number;
}

export const ScalingConfiguration: React.FC<ScalingConfigurationProps> = ({
  functionId,
}) => {
  const [config, setConfig] = useState<ScalingConfig>({
    minInstances: 1,
    maxInstances: 10,
    targetCpuUtilization: 70,
    targetMemoryUtilization: 70,
    scaleUpThreshold: 80,
    scaleDownThreshold: 40,
    cooldownPeriod: 300,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    const loadConfig = async () => {
      try {
        const loadedConfig = await getScalingConfig(functionId);
        setConfig(loadedConfig);
      } catch (error) {
        console.error('Error loading scaling configuration:', error);
        setError('Failed to load scaling configuration');
      }
    };

    loadConfig();
  }, [functionId]);

  const handleChange = (field: keyof ScalingConfig) => (
    event: React.ChangeEvent<HTMLInputElement> | any,
  ) => {
    const value = Number(event.target?.value ?? event);
    setConfig((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(false);

    try {
      await updateScalingConfig(functionId, config);
      setSuccess(true);
    } catch (error) {
      console.error('Error updating scaling configuration:', error);
      setError('Failed to update scaling configuration');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Auto-Scaling Configuration
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {success && (
          <Alert severity="success" sx={{ mb: 2 }}>
            Configuration updated successfully
          </Alert>
        )}

        <form onSubmit={handleSubmit}>
          <Grid container spacing={3}>
            <Grid item xs={12} md={6}>
              <Typography gutterBottom>Instance Limits</Typography>
              <TextField
                label="Minimum Instances"
                type="number"
                value={config.minInstances}
                onChange={handleChange('minInstances')}
                fullWidth
                margin="normal"
                inputProps={{ min: 1 }}
              />
              <TextField
                label="Maximum Instances"
                type="number"
                value={config.maxInstances}
                onChange={handleChange('maxInstances')}
                fullWidth
                margin="normal"
                inputProps={{ min: config.minInstances }}
              />
            </Grid>

            <Grid item xs={12} md={6}>
              <Typography gutterBottom>Resource Targets</Typography>
              <Box sx={{ px: 2 }}>
                <Typography>Target CPU Utilization (%)</Typography>
                <Slider
                  value={config.targetCpuUtilization}
                  onChange={handleChange('targetCpuUtilization')}
                  valueLabelDisplay="auto"
                  min={0}
                  max={100}
                />
                <Typography>Target Memory Utilization (%)</Typography>
                <Slider
                  value={config.targetMemoryUtilization}
                  onChange={handleChange('targetMemoryUtilization')}
                  valueLabelDisplay="auto"
                  min={0}
                  max={100}
                />
              </Box>
            </Grid>

            <Grid item xs={12} md={6}>
              <Typography gutterBottom>Scaling Thresholds</Typography>
              <Box sx={{ px: 2 }}>
                <Typography>Scale Up Threshold (%)</Typography>
                <Slider
                  value={config.scaleUpThreshold}
                  onChange={handleChange('scaleUpThreshold')}
                  valueLabelDisplay="auto"
                  min={0}
                  max={100}
                />
                <Typography>Scale Down Threshold (%)</Typography>
                <Slider
                  value={config.scaleDownThreshold}
                  onChange={handleChange('scaleDownThreshold')}
                  valueLabelDisplay="auto"
                  min={0}
                  max={100}
                />
              </Box>
            </Grid>

            <Grid item xs={12} md={6}>
              <Typography gutterBottom>Timing Configuration</Typography>
              <TextField
                label="Cooldown Period (seconds)"
                type="number"
                value={config.cooldownPeriod}
                onChange={handleChange('cooldownPeriod')}
                fullWidth
                margin="normal"
                inputProps={{ min: 60 }}
                helperText="Minimum time between scaling actions"
              />
            </Grid>

            <Grid item xs={12}>
              <Button
                type="submit"
                variant="contained"
                color="primary"
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save Configuration'}
              </Button>
            </Grid>
          </Grid>
        </form>
      </CardContent>
    </Card>
  );
};
