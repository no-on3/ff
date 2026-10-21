import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  FormControlLabel,
  FormGroup,
  Radio,
  RadioGroup,
  TextField,
  Typography,
} from '@mui/material';
import axios from 'axios';
import { AuthType, CORS_METHODS, CorsForm, FunctionUrl as Url, authTypeText, corsFormOf, corsOf, corsText, curlExample } from '../lib/function-url';
import { apiErrorMessage } from '../lib/functions';
import { Function, functionUrlApi } from '../services/api';

interface FunctionUrlProps {
  func: Function;
  mayChange: boolean;
}

/** The form's fields: who may call, and CORS. */
interface UrlForm {
  authType: AuthType;
  cors: CorsForm;
}

const formOf = (url: Url | null): UrlForm => ({ authType: url?.authType ?? 'NONE', cors: corsFormOf(url?.cors ?? null) });

/**
 * A function's URL, as AWS Lambda's function URLs: a web address that calls
 * the function with every request, its answer the response. Its address is
 * random and stays until the URL is deleted. Owners and developers create,
 * change and delete it; every member sees it.
 */
export const FunctionUrlTab: React.FC<FunctionUrlProps> = ({ func, mayChange }) => {
  /** undefined while loading; null when the function has none. */
  const [url, setUrl] = useState<Url | null | undefined>(undefined);
  const [form, setForm] = useState<UrlForm>(formOf(null));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let current = true;
    functionUrlApi
      .get(func.id)
      .then(({ data }) => current && setUrl(data))
      .catch((err: unknown) => {
        if (!current) return;
        if (axios.isAxiosError(err) && err.response?.status === 404) setUrl(null);
        else setError(apiErrorMessage(err));
      });
    return () => {
      current = false;
    };
  }, [func.id]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const cors = corsOf(form.cors);
    if ('problem' in cors) {
      setError(cors.problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = { authType: form.authType, cors: cors.cors };
      const { data } = url ? await functionUrlApi.update(func.id, body) : await functionUrlApi.create(func.id, body);
      setUrl(data);
      setForm(formOf(data));
      setEditing(false);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm('Delete this URL? Its address stops answering at once, and a new URL gets another address.')) return;
    setBusy(true);
    setError(null);
    try {
      await functionUrlApi.remove(func.id);
      setUrl(null);
      setForm(formOf(null));
      setEditing(false);
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Your browser did not let this page copy: select the address and copy it.');
    }
  };

  const setCors = (fields: Partial<CorsForm>) => setForm({ ...form, cors: { ...form.cors, ...fields } });
  const toggleMethod = (method: string, checked: boolean) =>
    setCors({ allowMethods: checked ? [...form.cors.allowMethods, method] : form.cors.allowMethods.filter((m) => m !== method) });

  const configuration = (
    <form onSubmit={save}>
      <Typography variant="subtitle2" sx={{ mt: 2 }}>
        Who may call it
      </Typography>
      <RadioGroup value={form.authType} onChange={(event) => setForm({ ...form, authType: event.target.value as AuthType })}>
        <FormControlLabel value="NONE" control={<Radio />} label="Anyone: a public address, every call on your account's bill" />
        <FormControlLabel
          value="AWS_IAM"
          control={<Radio />}
          label="Only callers with an API key of this account that has functions:invoke, sent as Authorization: Bearer ffk_…"
        />
      </RadioGroup>

      <FormControlLabel
        sx={{ mt: 1 }}
        control={<Checkbox checked={form.cors.enabled} onChange={(event) => setCors({ enabled: event.target.checked })} />}
        label="Let web pages on other sites call it from a browser (CORS)"
      />
      {form.cors.enabled && (
        <Box sx={{ display: 'grid', gap: 2, mt: 1, pl: 4 }}>
          <TextField
            label="Allowed origins"
            multiline
            minRows={2}
            value={form.cors.allowOrigins}
            onChange={(event) => setCors({ allowOrigins: event.target.value })}
            helperText="One a line, such as https://www.example.tn; * for any site"
            slotProps={{ htmlInput: { spellCheck: false } }}
          />
          <Box>
            <Typography variant="body2" color="text.secondary">
              Allowed methods
            </Typography>
            <FormGroup row>
              {CORS_METHODS.map((method) => (
                <FormControlLabel
                  key={method}
                  label={method === '*' ? 'Any' : method}
                  control={<Checkbox checked={form.cors.allowMethods.includes(method)} onChange={(event) => toggleMethod(method, event.target.checked)} />}
                />
              ))}
            </FormGroup>
          </Box>
          <TextField
            label="Allowed headers"
            value={form.cors.allowHeaders}
            onChange={(event) => setCors({ allowHeaders: event.target.value })}
            helperText="The headers a page may send, such as content-type; * for any"
            slotProps={{ htmlInput: { spellCheck: false } }}
          />
          <TextField
            label="Exposed headers"
            value={form.cors.exposeHeaders}
            onChange={(event) => setCors({ exposeHeaders: event.target.value })}
            helperText="The answer's headers a page's script may read"
            slotProps={{ htmlInput: { spellCheck: false } }}
          />
          <FormControlLabel
            control={<Checkbox checked={form.cors.allowCredentials} onChange={(event) => setCors({ allowCredentials: event.target.checked })} />}
            label="Allow the page's cookies and credentials"
          />
          <TextField
            label="Max age (s)"
            value={form.cors.maxAge}
            onChange={(event) => setCors({ maxAge: event.target.value })}
            helperText="How long a browser may keep a preflight's answer; empty for its own default"
            sx={{ maxWidth: 240 }}
          />
        </Box>
      )}

      <Box sx={{ display: 'flex', gap: 2, mt: 3 }}>
        <Button type="submit" variant="contained" disabled={busy}>
          {busy ? 'Saving…' : url ? 'Save' : 'Create URL'}
        </Button>
        {url && (
          <Button
            disabled={busy}
            onClick={() => {
              setForm(formOf(url));
              setEditing(false);
              setError(null);
            }}
          >
            Cancel
          </Button>
        )}
      </Box>
    </form>
  );

  return (
    <Card>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          URL
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          A web address for this function, as AWS Lambda&apos;s function URLs: every request to it, any method and path, calls the function with
          Lambda&apos;s event for function URLs, and what the function returns is the response. Calls count and cost as invokes do.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ my: 2 }}>
            {error}
          </Alert>
        )}

        {func.eventFormat === 'wrapped' ? (
          <Alert severity="info" sx={{ my: 2 }}>
            A URL sends AWS Lambda&apos;s event, and this function takes FF&apos;s original one, with the input in event.body. Move it to AWS
            Lambda&apos;s event first, in Overview.
          </Alert>
        ) : url === undefined ? (
          <Typography variant="body2" sx={{ my: 2 }}>
            Loading…
          </Typography>
        ) : url === null ? (
          mayChange ? (
            configuration
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ my: 2 }}>
              This function has no URL. Owners and developers can give it one.
            </Typography>
          )
        ) : (
          <>
            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap', my: 2 }}>
              <Typography component="code" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>
                {url.functionUrl}
              </Typography>
              <Button size="small" variant="outlined" onClick={() => void copy(url.functionUrl)}>
                {copied ? 'Copied' : 'Copy'}
              </Button>
              {url.authType === 'NONE' && (
                <Button size="small" href={url.functionUrl} target="_blank" rel="noopener noreferrer">
                  Open
                </Button>
              )}
            </Box>
            <Typography variant="body2">{authTypeText(url.authType)}</Typography>
            <Typography variant="body2">{corsText(url.cors)}</Typography>
            <Typography component="pre" variant="body2" sx={{ fontFamily: 'monospace', bgcolor: 'grey.100', p: 1, mt: 2, overflowX: 'auto' }}>
              {curlExample(url)}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Each answer carries x-amzn-RequestId, the call&apos;s request ID in the history and the logs. A function that fails answers 502, its
              error in the history only.
            </Typography>
            {mayChange &&
              (editing ? (
                configuration
              ) : (
                <Box sx={{ display: 'flex', gap: 2, mt: 3 }}>
                  <Button variant="outlined" disabled={busy} onClick={() => setEditing(true)}>
                    Change
                  </Button>
                  <Button color="error" disabled={busy} onClick={() => void remove()}>
                    Delete URL
                  </Button>
                </Box>
              ))}
          </>
        )}
      </CardContent>
    </Card>
  );
};
