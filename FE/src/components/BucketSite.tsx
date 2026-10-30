import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { domainInputProblem, recordText } from '../lib/custom-domains';
import { formatSize } from '../lib/databases';
import { apiErrorMessage } from '../lib/functions';
import {
  SiteDomain,
  SiteMetrics,
  Website,
  WebsiteForm,
  deployCommand,
  missingPathText,
  siteDomainStatusText,
  syncCommand,
  visitsSummary,
  websiteBody,
  websiteForm,
} from '../lib/sites';
import { Bucket, sitesApi } from '../services/api';
import Copyable from './Copyable';
import { Callout, Panel } from './Panel';

/** The settings' form: what a folder's path answers, what a path with no file answers. */
const SettingsForm: React.FC<{
  form: WebsiteForm;
  setForm: (form: WebsiteForm) => void;
  busy: boolean;
  submit: string;
  onSubmit: (event: React.FormEvent) => void;
  onCancel?: () => void;
}> = ({ form, setForm, busy, submit, onSubmit, onCancel }) => (
  <form onSubmit={onSubmit} className="space-y-4" aria-label="The site's settings">
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-[13px] text-gray-700">
        Index document, what a folder's path answers
        <input className="input font-mono" value={form.indexDocument} placeholder="index.html" onChange={(e) => setForm({ ...form, indexDocument: e.target.value })} />
      </label>
      <label className="flex flex-col gap-1 text-[13px] text-gray-700">
        Error document, with 404 (optional)
        <input className="input font-mono" value={form.errorDocument} placeholder="404.html" onChange={(e) => setForm({ ...form, errorDocument: e.target.value })} />
      </label>
    </div>
    <label className="flex items-start gap-2 text-[13px] text-gray-700">
      <input type="checkbox" className="mt-0.5" checked={form.singlePageApp} onChange={(e) => setForm({ ...form, singlePageApp: e.target.checked })} />
      <span>
        A single-page app: a path with no file answers the index document, with 200, so that the app's own routes load, as CloudFront's custom error response does.
      </span>
    </label>
    <div className="flex flex-wrap gap-3">
      <button type="submit" className="btn btn-primary" disabled={busy}>
        {busy ? 'Saving…' : submit}
      </button>
      {onCancel && (
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  </form>
);

/**
 * A bucket's site, as S3's website hosting: off until its website
 * configuration is set; then every file of the bucket is public to read at the
 * site's address, its S3 API still signed. Every member sees it; owners and
 * developers make it a site, change its settings, stop it, and add its own
 * domains, proved by DNS as a function URL's are.
 */
export const BucketSite: React.FC<{ bucket: Bucket; mayChange: boolean; onChange: () => void }> = ({ bucket, mayChange, onChange }) => {
  /** undefined while it loads; null when the bucket is no site. */
  const [website, setWebsite] = useState<Website | null | undefined>(undefined);
  const [form, setForm] = useState<WebsiteForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setWebsite((await sitesApi.get(bucket.name)).data);
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) setWebsite(null);
      else setError(apiErrorMessage(err));
    }
  }, [bucket.name]);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const save = (event: React.FormEvent) => {
    event.preventDefault();
    if (!form) return;
    const made = websiteBody(form);
    if ('problem' in made) return setError(made.problem);
    void act(async () => {
      setWebsite((await sitesApi.put(bucket.name, made.body)).data);
      setForm(null);
      onChange();
    });
  };

  const stop = () => {
    if (!window.confirm(`Stop serving ${bucket.name} as a site? Its address stops answering at once; its files are kept, private again.`)) return;
    void act(async () => {
      await sitesApi.remove(bucket.name);
      setWebsite(null);
      onChange();
    });
  };

  return (
    <Panel
      aria-label="Site"
      title="Site"
      description="Its files, public to read at an address of their own over HTTPS, as S3's website hosting serves them: a built frontend, its pages and assets."
      actions={
        mayChange && website && form === null ? (
          <>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setForm(websiteForm(website))}>
              Change its settings
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={stop}>
              Stop it
            </button>
          </>
        ) : undefined
      }
    >
      {error && (
        <Callout tone="danger" role="alert" className="mb-4">
          {error}
        </Callout>
      )}
      {website === undefined && !error && <p className="text-[13px] text-gray-500">Loading…</p>}
      {website === null &&
        (mayChange ? (
          form === null ? (
            <div className="space-y-3">
              <p className="text-[13px] text-gray-600">
                It is no site: its files are private, reached with the account's keys alone. As a site, every one of them is public to read at its address.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setForm(websiteForm(null))}>
                Make it a site
              </button>
            </div>
          ) : (
            <SettingsForm form={form} setForm={setForm} busy={busy} submit="Make it a site" onSubmit={save} onCancel={() => setForm(null)} />
          )
        ) : (
          <p className="text-[13px] text-gray-600">It is no site: owners and developers can make it one.</p>
        ))}
      {website && (
        <div className="space-y-4">
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-gray-700">Its address</p>
            <a href={website.url} target="_blank" rel="noreferrer" className="break-all font-mono text-[13px]">
              {website.url}
            </a>
          </div>
          {form ? (
            <SettingsForm form={form} setForm={setForm} busy={busy} submit="Save" onSubmit={save} onCancel={() => setForm(null)} />
          ) : (
            <p className="text-[13px] text-gray-700">
              A folder's path answers <code className="font-mono">{website.indexDocument.suffix}</code>. {missingPathText(website)}
            </p>
          )}
          <SiteVisits bucket={bucket.name} />
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-gray-700">Its files go up with ff, which sends what changed and deletes the rest</p>
            <Copyable value={deployCommand(bucket)} label="the deploy command" />
          </div>
          <div>
            <p className="mb-1.5 text-[13px] font-medium text-gray-700">Or with the AWS CLI and one of the account's access keys</p>
            <Copyable value={syncCommand(bucket)} label="the sync command" />
          </div>
          <SiteDomains bucket={bucket.name} siteUrl={website.url} mayChange={mayChange} />
        </div>
      )}
    </Panel>
  );
};

/** The site's visits over the last day, from its metrics, as CloudWatch names a CloudFront distribution's; alarms on them are made on the Alarms page. */
const SiteVisits: React.FC<{ bucket: string }> = ({ bucket }) => {
  const [metrics, setMetrics] = useState<SiteMetrics | null>(null);
  useEffect(() => {
    let current = true;
    const start = new Date(Date.now() - 23 * 3_600_000).toISOString();
    sitesApi
      .metrics(bucket, { period: 3600, start })
      .then(({ data }) => current && setMetrics(data))
      .catch(() => current && setMetrics(null));
    return () => {
      current = false;
    };
  }, [bucket]);
  if (!metrics) return null;
  const { visits, bytes, failedPercent } = visitsSummary(metrics);
  return (
    <p className="text-[13px] text-gray-700" aria-label="Its visits">
      {visits === 0
        ? 'No visit in the last 24 hours.'
        : `${visits.toLocaleString('en-US')} visit${visits === 1 ? '' : 's'} in the last 24 hours, ${formatSize(bytes)} sent, ${failedPercent}% answered with an error.`}
    </p>
  );
};

const Records: React.FC<{ title: string; records: SiteDomain['records']['cname'] }> = ({ title, records }) => (
  <div className="mt-2">
    <p className="text-[13px] text-gray-600">{title}</p>
    <pre className="mt-1 overflow-x-auto rounded bg-gray-100 px-3 py-2 font-mono text-[13px]">{records.map(recordText).join('\n')}</pre>
  </div>
);

/** The site's own domains: each added, proved by DNS, then served over HTTPS, its certificate made at its first request. */
const SiteDomains: React.FC<{ bucket: string; siteUrl: string; mayChange: boolean }> = ({ bucket, siteUrl, mayChange }) => {
  const [domains, setDomains] = useState<SiteDomain[] | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    sitesApi
      .domains(bucket)
      .then(({ data }) => current && setDomains(data))
      .catch((err: unknown) => current && setError(apiErrorMessage(err)));
    return () => {
      current = false;
    };
  }, [bucket]);

  const replace = (domain: SiteDomain) => setDomains((all) => [...(all ?? []).filter((d) => d.domain !== domain.domain), domain]);
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
    if (problem) return setError(problem);
    void act('add', async () => {
      replace((await sitesApi.addDomain(bucket, name.trim())).data);
      setName('');
    });
  };
  const remove = (domain: string) => {
    if (!window.confirm(`Remove ${domain}? The site stops answering there at once.`)) return;
    void act(domain, async () => {
      await sitesApi.removeDomain(bucket, domain);
      setDomains((all) => (all ?? []).filter((d) => d.domain !== domain));
    });
  };

  return (
    <section aria-label="Its own domains" className="border-t border-line pt-4">
      <h3 className="text-[14px] font-semibold text-ink">Your own domains</h3>
      <p className="mt-0.5 mb-3 text-[13px] text-gray-600">
        The site can answer at a domain of yours too, such as www.shop.tn. Add it, make the DNS records it shows at your DNS provider, then check it.
      </p>
      {error && (
        <Callout tone="danger" role="alert" className="mb-3">
          {error}
        </Callout>
      )}
      {domains === null && !error && <p className="text-[13px] text-gray-500">Loading…</p>}
      {domains?.length === 0 && <p className="text-[13px] text-gray-600">No domain of yours yet.</p>}
      {domains && domains.length > 0 && (
        <ul className="divide-y divide-gray-100" aria-label="The site's domains">
          {domains.map((domain) => (
            <li key={domain.domain} data-domain={domain.domain} className="py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="font-mono text-[13px] text-ink">{domain.domain}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs ${domain.status === 'verified' ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800'}`}>
                  {domain.status === 'verified' ? 'Verified' : 'Pending'}
                </span>
                {mayChange && (
                  <span className="ml-auto flex gap-2">
                    <button
                      type="button"
                      className="btn btn-secondary"
                      disabled={busy !== null}
                      onClick={() => void act(domain.domain, async () => replace((await sitesApi.verifyDomain(bucket, domain.domain)).data))}
                    >
                      {busy === domain.domain ? 'Checking…' : 'Check again'}
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => remove(domain.domain)}>
                      Remove
                    </button>
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-[13px] text-gray-700">{siteDomainStatusText(domain, siteUrl)}</p>
              {domain.checkError && <p className="mt-1 text-[13px] text-red-700">{domain.checkError}</p>}
              {domain.status === 'pending' && (
                <>
                  <Records title="Either, for a subdomain such as www.shop.tn: a CNAME to the site" records={domain.records.cname} />
                  <Records title="Or, for any domain, a domain apex such as shop.tn too: the TXT record, and the addresses" records={domain.records.txt} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {mayChange && (
        <form onSubmit={add} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-[13px] text-gray-700">
            Domain
            <input className="input font-mono" value={name} placeholder="www.shop.tn" spellCheck={false} autoCapitalize="off" onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary" disabled={busy !== null}>
            {busy === 'add' ? 'Adding…' : 'Add'}
          </button>
        </form>
      )}
    </section>
  );
};
