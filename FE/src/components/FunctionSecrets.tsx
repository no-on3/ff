import React, { useState } from 'react';
import { Alert, Box, Button, Card, CardContent, TextField, Typography } from '@mui/material';
import { secretProblem } from '../lib/environment';
import { apiErrorMessage } from '../lib/functions';
import { SecretView, secretsApi } from '../services/api';

interface FunctionSecretsProps {
  functionId: string;
  secrets: SecretView[] | null;
  /** The function's variables' names: a name is a variable or a secret, not both. */
  variableNames: string[];
  mayChange: boolean;
  /** The secrets as the API answered a change, once the new version is live. */
  onChanged: (secrets: SecretView[]) => void;
}

/**
 * A function's secrets: variables whose values nobody reads back, not even
 * this page. Setting or removing one rolls out a new version, which the API
 * waits for. The function reads them as it reads its variables.
 */
export const FunctionSecrets: React.FC<FunctionSecretsProps> = ({ functionId, secrets, variableNames, mayChange, onChanged }) => {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const change = async (changes: Record<string, string | null>, what: string) => {
    setBusy(what);
    setError(null);
    setDone(null);
    try {
      const { data } = await secretsApi.change(functionId, changes);
      onChanged(data.secrets);
      setDone(`${what}. The new version is live.`);
      return true;
    } catch (err) {
      setError(apiErrorMessage(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const set = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    const problem = secretProblem(trimmed, value, variableNames);
    if (problem) {
      setError(problem);
      return;
    }
    // The value leaves the form once it is sent: it is never shown again.
    if (await change({ [trimmed]: value }, `${trimmed} is set`)) {
      setName('');
      setValue('');
    }
  };

  const remove = (secret: string) => {
    if (window.confirm(`Remove the secret ${secret}? The function rolls out a new version without it.`)) void change({ [secret]: null }, `${secret} is removed`);
  };

  return (
    <Card sx={{ mt: 3 }}>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Secrets
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Passwords, keys and tokens: your code reads them as it reads its variables, but nobody reads their values back, not even here. They
          are encrypted at rest, count in the 4 KB with the variables, and setting or removing one rolls out a new version.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ my: 2 }}>
            {error}
          </Alert>
        )}
        {done && (
          <Alert severity="success" sx={{ my: 2 }}>
            {done}
          </Alert>
        )}

        {secrets === null ? (
          <Typography variant="body2" sx={{ my: 2 }}>
            Loading…
          </Typography>
        ) : secrets.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ my: 2 }}>
            This function has no secrets.
          </Typography>
        ) : (
          secrets.map((secret) => (
            <Box key={secret.name} sx={{ display: 'flex', gap: 2, mt: 1, alignItems: 'center' }}>
              <Typography sx={{ fontFamily: 'monospace', minWidth: 220 }}>{secret.name}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
                set {new Date(secret.updatedAt).toLocaleString()}
              </Typography>
              {mayChange && (
                <Button size="small" color="error" disabled={busy !== null} onClick={() => remove(secret.name)}>
                  Remove
                </Button>
              )}
            </Box>
          ))
        )}

        {mayChange ? (
          <form onSubmit={set}>
            <Box sx={{ display: 'flex', gap: 2, mt: 3, alignItems: 'center' }}>
              <TextField
                label="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                sx={{ minWidth: 220 }}
                helperText="A new name, or one above to replace its value"
                slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off' } }}
              />
              <TextField
                label="Value"
                type="password"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                fullWidth
                helperText="Never shown again once set"
                slotProps={{ htmlInput: { autoComplete: 'new-password' } }}
              />
              <Button type="submit" variant="contained" disabled={busy !== null} sx={{ alignSelf: 'flex-start', mt: 1 }}>
                {busy !== null ? 'Saving…' : 'Set'}
              </Button>
            </Box>
          </form>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            As a viewer, you see the secrets&apos; names; owners and developers set and remove them.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
};
