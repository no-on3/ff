import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, Card, CardContent, Chip, TextField, Typography } from '@mui/material';
import { CustomDomain, domainInputProblem, domainStatusText, recordText } from '../lib/custom-domains';
import { apiErrorMessage } from '../lib/functions';
import { domainsApi } from '../services/api';

interface FunctionUrlDomainsProps {
  functionId: string;
  /** The URL's own address, whose scheme and port its domains share. */
  functionUrl: string;
  mayChange: boolean;
}

const Records: React.FC<{ title: string; records: CustomDomain['records']['cname'] }> = ({ title, records }) => (
  <Box sx={{ mt: 1 }}>
    <Typography variant="body2" color="text.secondary">
      {title}
    </Typography>
    <Typography component="pre" variant="body2" sx={{ fontFamily: 'monospace', bgcolor: 'grey.100', p: 1, mt: 0.5, overflowX: 'auto' }}>
      {records.map(recordText).join('\n')}
    </Typography>
  </Box>
);

/**
 * A function URL's own domains: each added, proved by DNS, then served over
 * HTTPS, its certificate made at its first request. Owners and developers add,
 * check and remove them; every member sees them.
 */
export const FunctionUrlDomains: React.FC<FunctionUrlDomainsProps> = ({ functionId, functionUrl, mayChange }) => {
  const [domains, setDomains] = useState<CustomDomain[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    domainsApi
      .list(functionId)
      .then(({ data }) => current && setDomains(data))
      .catch((err: unknown) => current && setError(apiErrorMessage(err)));
    return () => {
      current = false;
    };
  }, [functionId]);

  const replace = (domain: CustomDomain) => setDomains((all) => [...(all ?? []).filter((d) => d.domain !== domain.domain), domain]);

  const act = async (what: string, work: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const add = (event: React.FormEvent) => {
    event.preventDefault();
    const problem = domainInputProblem(name);
    if (problem) {
      setError(problem);
      return;
    }
    void act('add', async () => {
      replace((await domainsApi.add(functionId, name.trim())).data);
      setName('');
    });
  };

  const verify = (domain: string) => void act(domain, async () => replace((await domainsApi.verify(functionId, domain)).data));

  const remove = (domain: string) => {
    if (!window.confirm(`Remove ${domain}? The URL stops answering there at once.`)) return;
    void act(domain, async () => {
      await domainsApi.remove(functionId, domain);
      setDomains((all) => (all ?? []).filter((d) => d.domain !== domain));
    });
  };

  return (
    <Card sx={{ mt: 3 }}>
      <CardContent>
        <Typography variant="h6" gutterBottom>
          Your own domains
        </Typography>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          The URL can answer at a domain of yours too, such as shop.example.tn, over HTTPS. Add it, make the DNS records it shows at your DNS
          provider, then check it: once the DNS proves the domain is yours, the URL answers there.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ my: 2 }}>
            {error}
          </Alert>
        )}

        {domains === null ? (
          <Typography variant="body2" sx={{ my: 2 }}>
            Loading…
          </Typography>
        ) : domains.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ my: 2 }}>
            No domain of yours yet.
          </Typography>
        ) : (
          domains.map((domain) => (
            <Box key={domain.domain} sx={{ borderTop: 1, borderColor: 'divider', py: 2 }}>
              <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                <Typography sx={{ fontFamily: 'monospace' }}>{domain.domain}</Typography>
                <Chip size="small" label={domain.status === 'verified' ? 'Verified' : 'Pending'} color={domain.status === 'verified' ? 'success' : 'warning'} />
                {mayChange && (
                  <Box sx={{ ml: 'auto', display: 'flex', gap: 1 }}>
                    <Button size="small" variant="outlined" disabled={busy !== null} onClick={() => verify(domain.domain)}>
                      {busy === domain.domain ? 'Checking…' : 'Check again'}
                    </Button>
                    <Button size="small" color="error" disabled={busy !== null} onClick={() => remove(domain.domain)}>
                      Remove
                    </Button>
                  </Box>
                )}
              </Box>
              <Typography variant="body2" sx={{ mt: 1 }}>
                {domainStatusText(domain, functionUrl)}
              </Typography>
              {domain.checkError && (
                <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
                  {domain.checkError}
                  {domain.checkedAt ? ` (checked ${new Date(domain.checkedAt).toLocaleString()})` : ''}
                </Typography>
              )}
              {domain.status === 'pending' && (
                <>
                  <Records title="Either, for a subdomain such as shop.example.tn: a CNAME to the URL" records={domain.records.cname} />
                  <Records title="Or, for any domain, a domain apex such as example.tn too: the TXT record, and the addresses" records={domain.records.txt} />
                </>
              )}
            </Box>
          ))
        )}

        {mayChange ? (
          <form onSubmit={add}>
            <Box sx={{ display: 'flex', gap: 2, mt: 2, alignItems: 'flex-start' }}>
              <TextField
                label="Domain"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="shop.example.tn"
                sx={{ minWidth: 300 }}
                slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off' } }}
              />
              <Button type="submit" variant="contained" disabled={busy !== null} sx={{ mt: 1 }}>
                {busy === 'add' ? 'Adding…' : 'Add'}
              </Button>
            </Box>
          </form>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            As a viewer, you see the domains; owners and developers add and remove them.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
};
