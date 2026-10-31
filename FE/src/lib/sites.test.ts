import { describe, expect, it } from 'vitest';
import { SiteMetrics, deployCommand, missingPathText, siteDomainStatusText, syncCommand, visitsSummary, websiteBody, websiteForm } from './sites';

describe("a bucket's site settings", () => {
  it('starts a new site with index.html, no error document, not a single-page app', () => {
    expect(websiteForm(null)).toEqual({ indexDocument: 'index.html', errorDocument: '', singlePageApp: false });
    expect(websiteForm({ indexDocument: { suffix: 'home.html' }, errorDocument: { key: '404.html' }, singlePageApp: true, url: 'https://shop.site.ff.tn' })).toEqual({
      indexDocument: 'home.html',
      errorDocument: '404.html',
      singlePageApp: true,
    });
  });

  it('sends the configuration whole, as S3 takes it, without an error document left empty', () => {
    expect(websiteBody({ indexDocument: ' index.html ', errorDocument: '', singlePageApp: true })).toEqual({ body: { indexDocument: { suffix: 'index.html' }, singlePageApp: true } });
    expect(websiteBody({ indexDocument: 'index.html', errorDocument: 'errors/404.html', singlePageApp: false })).toEqual({
      body: { indexDocument: { suffix: 'index.html' }, errorDocument: { key: 'errors/404.html' }, singlePageApp: false },
    });
  });

  it('refuses what the API would: no index document, or one with a slash', () => {
    expect(websiteBody({ indexDocument: ' ', errorDocument: '', singlePageApp: false })).toEqual({ problem: 'Name the index document, such as index.html' });
    expect(websiteBody({ indexDocument: 'docs/index.html', errorDocument: '', singlePageApp: false })).toEqual({
      problem: "The index document is a name without a slash, as S3's Suffix: it is appended to each folder's path",
    });
  });

  it('says what a path with no file answers', () => {
    const index = { suffix: 'index.html' };
    expect(missingPathText({ indexDocument: index, singlePageApp: true, errorDocument: { key: '404.html' } })).toBe(
      "A path with no file answers index.html, with 200, for a single-page app's own routes.",
    );
    expect(missingPathText({ indexDocument: index, singlePageApp: false, errorDocument: { key: '404.html' } })).toBe('A path with no file answers 404.html, with 404.');
    expect(missingPathText({ indexDocument: index, singlePageApp: false })).toBe("A path with no file answers FF's own page, with 404.");
  });
});

describe("a site's files and domains", () => {
  it("uploads with ff's command, or the AWS CLI's sync at FF's endpoint", () => {
    expect(deployCommand({ name: 'shop' })).toBe('ff sites deploy shop ./dist');
    expect(syncCommand({ name: 'shop', endpoint: 'https://s3.ffunc.cloud' })).toBe('aws s3 sync ./dist s3://shop --delete --endpoint-url https://s3.ffunc.cloud');
  });

  it("says where a domain stands: verified, at the site's scheme and port", () => {
    expect(siteDomainStatusText({ domain: 'www.shop.tn', status: 'verified' }, 'https://shop.site.ffunc.cloud')).toBe(
      'Verified: the site answers at https://www.shop.tn/, its certificate made at the first request.',
    );
    expect(siteDomainStatusText({ domain: 'www.shop.tn', status: 'verified' }, 'http://shop.site.localhost:3004')).toBe('Verified: the site answers at http://www.shop.tn:3004/.');
    expect(siteDomainStatusText({ domain: 'www.shop.tn', status: 'pending' }, 'https://shop.site.ffunc.cloud')).toBe(
      'Waiting for its DNS records: make one of the sets below, then check again.',
    );
  });
});

describe("a site's visits", () => {
  const metrics = (requests: number[], bytes: number[], failed: Array<number | null>): SiteMetrics => ({
    period: 3600,
    start: '2026-10-30T00:00:00.000Z',
    end: '2026-10-30T03:00:00.000Z',
    timestamps: ['2026-10-30T00:00:00.000Z', '2026-10-30T01:00:00.000Z', '2026-10-30T02:00:00.000Z'],
    metrics: {
      Requests: { Sum: requests },
      BytesDownloaded: { Sum: bytes },
      '4xxErrorRate': { Average: failed },
      '5xxErrorRate': { Average: failed.map((share) => (share === null ? null : 0)) },
      TotalErrorRate: { Average: failed },
    },
  });

  it("sums the window's visits and bytes, and the share that failed weighed by each period's visits", () => {
    // 1 of 4 visits failed, then none of 0, then 3 of 6: 4 of 10.
    expect(visitsSummary(metrics([4, 0, 6], [4_000, 0, 6_000], [25, null, 50]))).toEqual({ visits: 10, bytes: 10_000, failedPercent: 40 });
  });

  it('has no share without a visit', () => {
    expect(visitsSummary(metrics([0, 0, 0], [0, 0, 0], [null, null, null]))).toEqual({ visits: 0, bytes: 0, failedPercent: null });
  });
});
