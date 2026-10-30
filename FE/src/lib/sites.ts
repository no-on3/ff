/**
 * A bucket's site, as the console shows it: S3's website configuration in its
 * JSON names, the site's address, how its files go up, and its own domains,
 * proved as a function URL's are. contract.test.ts ties the fields to the API's.
 */
import type { Bucket } from '../services/api';
import { DomainRecord, DomainStatus, domainAddress } from './custom-domains';

/** The fields of a website configuration, as the API's WebsiteView names them. */
export const WEBSITE_FIELDS = ['indexDocument', 'errorDocument', 'singlePageApp', 'url'] as const;

export interface Website {
  indexDocument: { suffix: string };
  /** Without one, a path with no file answers FF's own page, with 404. */
  errorDocument?: { key: string };
  singlePageApp: boolean;
  /** The site's address: every file of the bucket is public to read there. */
  url: string;
}

/** What PUT /buckets/:name/website takes: the configuration whole. */
export type WebsiteBody = Omit<Website, 'url'>;

/** The fields of a site's domain, as the API's SiteDomainView names them. */
export const SITE_DOMAIN_FIELDS = ['domain', 'bucket', 'status', 'records', 'checkedAt', 'checkError', 'verifiedAt', 'createdAt'] as const;

export interface SiteDomain {
  domain: string;
  bucket: string;
  status: DomainStatus;
  /** Either set proves the domain: a CNAME to the site's host, or the TXT record and the edge's addresses. */
  records: { cname: DomainRecord[]; txt: DomainRecord[] };
  checkedAt: string | null;
  checkError: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

/** The settings' form: the index document, the error document ('' for none), and the single-page setting. */
export interface WebsiteForm {
  indexDocument: string;
  errorDocument: string;
  singlePageApp: boolean;
}

export const websiteForm = (website: Website | null): WebsiteForm => ({
  indexDocument: website?.indexDocument.suffix ?? 'index.html',
  errorDocument: website?.errorDocument?.key ?? '',
  singlePageApp: website?.singlePageApp ?? false,
});

/** The configuration the form says, or why the API would refuse it, said before sending it. */
export function websiteBody(form: WebsiteForm): { body: WebsiteBody } | { problem: string } {
  const index = form.indexDocument.trim();
  const error = form.errorDocument.trim();
  if (index === '') return { problem: 'Name the index document, such as index.html' };
  if (index.includes('/')) return { problem: "The index document is a name without a slash, as S3's Suffix: it is appended to each folder's path" };
  if (index.length > 1024 || error.length > 1024) return { problem: 'A name of 1024 characters at most' };
  return { body: { indexDocument: { suffix: index }, ...(error ? { errorDocument: { key: error } } : {}), singlePageApp: form.singlePageApp } };
}

/** What a path with no file answers, in a sentence. */
export function missingPathText(website: Pick<Website, 'errorDocument' | 'singlePageApp' | 'indexDocument'>): string {
  if (website.singlePageApp) return `A path with no file answers ${website.indexDocument.suffix}, with 200, for a single-page app's own routes.`;
  if (website.errorDocument) return `A path with no file answers ${website.errorDocument.key}, with 404.`;
  return "A path with no file answers FF's own page, with 404.";
}

/** The command that uploads a built site, `ff`'s: the files that changed, the rest deleted. */
export const deployCommand = (bucket: Pick<Bucket, 'name'>, folder = './dist'): string => `ff sites deploy ${bucket.name} ${folder}`;

/** The same with the AWS CLI and one of the account's access keys, its endpoint given. */
export const syncCommand = (bucket: Pick<Bucket, 'name' | 'endpoint'>, folder = './dist'): string =>
  `aws s3 sync ${folder} s3://${bucket.name} --delete --endpoint-url ${bucket.endpoint}`;

/** Where a site's domain stands, in a sentence. */
export function siteDomainStatusText(domain: Pick<SiteDomain, 'domain' | 'status'>, siteUrl: string): string {
  if (domain.status !== 'verified') return 'Waiting for its DNS records: make one of the sets below, then check again.';
  const address = domainAddress(domain.domain, siteUrl);
  return `Verified: the site answers at ${address}${address.startsWith('https:') ? ', its certificate made at the first request' : ''}.`;
}

/** A site's metrics, as the API's SiteMetricSeries names them, as CloudWatch names a CloudFront distribution's. */
export const SITE_METRICS = ['Requests', 'BytesDownloaded', '4xxErrorRate', '5xxErrorRate', 'TotalErrorRate'] as const;
type SiteRate = '4xxErrorRate' | '5xxErrorRate' | 'TotalErrorRate';

/** GET /buckets/:name/website/metrics: its visits and their bytes, each period's Sum; the shares of them that failed, in percent, null in a period without a visit. */
export interface SiteMetrics {
  period: number;
  start: string;
  end: string;
  timestamps: string[];
  metrics: { Requests: { Sum: number[] }; BytesDownloaded: { Sum: number[] } } & Record<SiteRate, { Average: Array<number | null> }>;
}

/** The visits of the metrics' window, the bytes they were sent, and the share of them that failed, in percent; null without a visit. */
export function visitsSummary(metrics: SiteMetrics): { visits: number; bytes: number; failedPercent: number | null } {
  const m = metrics.metrics;
  const visits = m.Requests.Sum.reduce((sum, value) => sum + value, 0);
  const bytes = m.BytesDownloaded.Sum.reduce((sum, value) => sum + value, 0);
  // Each period's share, weighed by its visits, gives back the visits that failed.
  const failed = m.TotalErrorRate.Average.reduce<number>((sum, share, index) => sum + ((share ?? 0) * m.Requests.Sum[index]) / 100, 0);
  return { visits, bytes, failedPercent: visits === 0 ? null : Math.round((1000 * failed) / visits) / 10 };
}
