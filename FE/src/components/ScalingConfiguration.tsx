import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, TextField, Typography } from '@mui/material';
import { apiErrorMessage, scalingLimitsError } from '../lib/functions';
import { ScalingConfig, ScalingLimits, getScalingConfig, updateScalingConfig } from '../services/api';
import { useSession } from '../session/session';

interface ScalingConfigurationProps {
  functionId: string;
}

/**
 * The function's instance limits. Each instance serves one call at a time:
 * when calls arrive at once, the function gets more instances, up to the
 * maximum, and goes back to zero when idle unless a minimum is set.
 */
export const ScalingConfiguration: React.FC<ScalingConfigurationProps> = ({ functionId }) => {
  const plan = useSession().account!.plan; // the function pages show only for an account
  const maxInstances = plan.limits.instancesPerFunction;
  const [config, setConfig] = useState<ScalingConfig | null>(null);
  const [form, setForm] = useState<ScalingLimits | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getScalingConfig(functionId)
      .then((loaded) => {
        setConfig(loaded);
        setForm({ minInstances: loaded.minInstances, maxInstances: loaded.maxInstances });
      })
      .catch((err: unknown) => setError(apiErrorMessage(err)));
  }, [functionId]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setSaved(false);
    const invalid = scalingLimitsError(form, plan);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await updateScalingConfig(functionId, form);
      setConfig(updated);
      setForm({ minInstances: updated.minInstances, maxInstances: updated.maxInstances });
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof ScalingLimits) => (event: React.ChangeEvent<HTMLInputElement>) =>
    form && setForm({ ...form, [key]: Number(event.target.value) });

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Scaling
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Each instance serves one call at a time. Calls that arrive at once get more instances, up to the maximum;
          a call waits at most one timeout for a free instance. An idle function goes back to zero instances, unless a
          minimum is set.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ my: 2 }}>
            {error}
          </Alert>
        )}
        {saved && (
          <Alert severity="success" sx={{ my: 2 }}>
            Saved. The running instances follow the new limits now.
          </Alert>
        )}

        {form && config && (
          <form onSubmit={handleSubmit}>
            <Box sx={{ display: 'flex', gap: 2, mt: 2 }}>
              <TextField
                label="Minimum instances"
                type="number"
                value={form.minInstances}
                onChange={field('minInstances')}
                sx={{ minWidth: 220 }}
                slotProps={{ htmlInput: { min: 0, max: maxInstances, step: 1 } }}
                helperText={form.minInstances > 0 ? 'Kept running even when idle' : 'Scales to zero when idle'}
              />
              <TextField
                label="Maximum instances"
                type="number"
                value={form.maxInstances}
                onChange={field('maxInstances')}
                sx={{ minWidth: 220 }}
                slotProps={{ htmlInput: { min: 1, max: maxInstances, step: 1 } }}
                helperText={`At most ${maxInstances} on the ${plan.name} plan`}
              />
            </Box>
            <Button type="submit" variant="contained" disabled={saving} sx={{ mt: 2 }}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
};
