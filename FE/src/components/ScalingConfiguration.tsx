import React, { useEffect, useState } from 'react';
import { Alert, Card, CardContent, Table, TableBody, TableCell, TableRow, Typography } from '@mui/material';
import { apiErrorMessage } from '../lib/functions';
import { ScalingConfig, getScalingConfig } from '../services/api';

interface ScalingConfigurationProps {
  functionId: string;
}

/**
 * The function's scaling settings, read-only: the API has no route to change
 * them yet. Which settings customers may change, within their plan, is
 * decided with the scaling model (client-readiness plan, P-06).
 */
export const ScalingConfiguration: React.FC<ScalingConfigurationProps> = ({ functionId }) => {
  const [config, setConfig] = useState<ScalingConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getScalingConfig(functionId)
      .then(setConfig)
      .catch((err: unknown) => setError(apiErrorMessage(err)));
  }, [functionId]);

  const rows: Array<[string, string]> = config
    ? [
        ['Minimum instances', String(config.minInstances)],
        ['Maximum instances', String(config.maxInstances)],
        ['Scales to zero when idle', config.scaleToZero ? 'Yes' : 'No'],
      ]
    : [];

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Scaling
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}

        {config && (
          <>
            <Table size="small">
              <TableBody>
                {rows.map(([label, value]) => (
                  <TableRow key={label}>
                    <TableCell>{label}</TableCell>
                    <TableCell>{value}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Alert severity="info" sx={{ mt: 2 }}>
              These settings can't be changed yet.
            </Alert>
          </>
        )}
      </CardContent>
    </Card>
  );
};
