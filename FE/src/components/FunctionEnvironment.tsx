import React, { useEffect, useMemo, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, IconButton, TextField, Typography } from '@mui/material';
import { MAX_ENVIRONMENT_BYTES, VariableRow, environmentBytes, environmentOf, environmentProblems, rowsOf, sameEnvironment } from '../lib/environment';
import { apiErrorMessage } from '../lib/functions';
import { Function, SecretView, functionsApi, secretsApi } from '../services/api';
import { FunctionSecrets } from './FunctionSecrets';

interface FunctionEnvironmentProps {
  func: Function;
  mayChange: boolean;
  /** The function as the API answered the update, the new variables in it. */
  onSaved: (updated: Function) => void;
}

/** The Environment tab: the function's variables, then its secrets, whose names a variable can't take, nor the reverse. */
export const EnvironmentTab: React.FC<FunctionEnvironmentProps> = ({ func, mayChange, onSaved }) => {
  const [secrets, setSecrets] = useState<SecretView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    secretsApi
      .list(func.id)
      .then(({ data }) => setSecrets(data.secrets))
      .catch((err: unknown) => setError(apiErrorMessage(err)));
  }, [func.id]);

  return (
    <>
      <FunctionEnvironment func={func} mayChange={mayChange} onSaved={onSaved} secretNames={(secrets ?? []).map((secret) => secret.name)} />
      {error ? (
        <Alert severity="error" sx={{ mt: 3 }}>
          {error}
        </Alert>
      ) : (
        <FunctionSecrets
          functionId={func.id}
          secrets={secrets}
          variableNames={Object.keys(func.environment ?? {})}
          mayChange={mayChange}
          onChanged={setSecrets}
        />
      )}
    </>
  );
};

/**
 * A function's environment variables, as on AWS Lambda: names and string
 * values, 4 KB at most. Saving rolls out a new version, which the API waits
 * for. Whoever reads the function reads them.
 */
export const FunctionEnvironment: React.FC<FunctionEnvironmentProps & { secretNames: string[] }> = ({ func, mayChange, onSaved, secretNames }) => {
  const [rows, setRows] = useState<VariableRow[]>(() => rowsOf(func.environment));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => setRows(rowsOf(func.environment)), [func.environment]);

  const environment = useMemo(() => environmentOf(rows), [rows]);
  const problems = useMemo(() => environmentProblems(rows, secretNames), [rows, secretNames]);
  const unchanged = sameEnvironment(environment, func.environment ?? {});

  const change = (index: number, field: keyof VariableRow) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setSaved(false);
    setRows(rows.map((row, i) => (i === index ? { ...row, [field]: event.target.value } : row)));
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (problems.length > 0 || unchanged) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const { data } = await functionsApi.updateFunction(func.id, { environment });
      onSaved(data);
      setSaved(true);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Environment variables
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Your code reads them as on AWS Lambda: <code>process.env.NAME</code> in Node.js, <code>os.environ[&quot;NAME&quot;]</code> in Python. They
          are encrypted at rest, and saving them rolls out a new version. Whoever reads this function reads them too: a password or a key
          belongs in a secret.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ my: 2 }}>
            {error}
          </Alert>
        )}
        {saved && (
          <Alert severity="success" sx={{ my: 2 }}>
            Saved. The new version is live.
          </Alert>
        )}

        <form onSubmit={save}>
          {rows.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ my: 2 }}>
              This function has no variables.
            </Typography>
          )}
          {rows.map((row, index) => (
            <Box key={index} sx={{ display: 'flex', gap: 2, mt: 2, alignItems: 'center' }}>
              <TextField
                label="Name"
                value={row.name}
                onChange={change(index, 'name')}
                disabled={!mayChange}
                sx={{ minWidth: 220 }}
                slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off' } }}
              />
              <TextField
                label="Value"
                value={row.value}
                onChange={change(index, 'value')}
                disabled={!mayChange}
                fullWidth
                slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off' } }}
              />
              {mayChange && (
                <IconButton aria-label={`Remove ${row.name || 'this variable'}`} onClick={() => setRows(rows.filter((_, i) => i !== index))}>
                  ×
                </IconButton>
              )}
            </Box>
          ))}

          <Typography variant="body2" color={environmentBytes(environment) > MAX_ENVIRONMENT_BYTES ? 'error' : 'text.secondary'} sx={{ mt: 2 }}>
            {environmentBytes(environment)} of {MAX_ENVIRONMENT_BYTES} bytes, with the secrets&apos; names and values on top
          </Typography>
          {problems.map((problem) => (
            <Typography key={problem} variant="body2" color="error">
              {problem}
            </Typography>
          ))}

          {mayChange ? (
            <Box sx={{ display: 'flex', gap: 2, mt: 2 }}>
              <Button variant="outlined" onClick={() => setRows([...rows, { name: '', value: '' }])}>
                Add a variable
              </Button>
              <Button type="submit" variant="contained" disabled={saving || unchanged || problems.length > 0}>
                {saving ? 'Saving… (waits until the new version is live)' : 'Save'}
              </Button>
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              As a viewer, you read these variables; owners and developers change them.
            </Typography>
          )}
        </form>
      </CardContent>
    </Card>
  );
};
