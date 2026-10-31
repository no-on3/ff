import { S3Error } from './s3-error';
import { WebsiteConfiguration, siteUrl, websiteFromJson, websiteFromXml, websiteJson, websiteXml } from './website';

/** The S3 error a call throws: its status and code, or 'none'. */
function refusal(call: () => unknown): string {
  try {
    call();
    return 'none';
  } catch (error) {
    if (error instanceof S3Error) return `${error.status} ${error.code}`;
    throw error;
  }
}

const document = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<WebsiteConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${inner}</WebsiteConfiguration>`;

describe("a bucket's website configuration, as S3's", () => {
  it("reads PutBucketWebsite's index and error documents, their text trimmed, and keeps the single-page setting S3's XML can't say", () => {
    const xml = document('<IndexDocument><Suffix> index.html </Suffix></IndexDocument><ErrorDocument><Key>errors/404.html</Key></ErrorDocument>');

    expect(websiteFromXml(xml, null)).toEqual({ indexDocument: 'index.html', errorDocument: 'errors/404.html', singlePageApp: false });
    expect(websiteFromXml(xml, { indexDocument: 'old.html', errorDocument: null, singlePageApp: true })).toEqual({
      indexDocument: 'index.html',
      errorDocument: 'errors/404.html',
      singlePageApp: true,
    });
    expect(websiteFromXml(document('<IndexDocument><Suffix>home.htm</Suffix></IndexDocument>'), null).errorDocument).toBeNull();
  });

  it('refuses what S3 refuses, in its words, and what FF does not do yet as not implemented', () => {
    expect(refusal(() => websiteFromXml(document('<ErrorDocument><Key>404.html</Key></ErrorDocument>'), null))).toBe('400 InvalidArgument');
    expect(refusal(() => websiteFromXml(document('<IndexDocument><Suffix>a/index.html</Suffix></IndexDocument>'), null))).toBe('400 InvalidArgument');
    expect(refusal(() => websiteFromXml(document('<IndexDocument><Suffix>index.html</Suffix></IndexDocument><ErrorDocument><Key></Key></ErrorDocument>'), null))).toBe(
      '400 InvalidArgument',
    );
    expect(refusal(() => websiteFromXml(document(`<IndexDocument><Suffix>${'a'.repeat(1025)}</Suffix></IndexDocument>`), null))).toBe('400 InvalidArgument');
    expect(refusal(() => websiteFromXml(document('<RedirectAllRequestsTo><HostName>example.tn</HostName></RedirectAllRequestsTo>'), null))).toBe('501 NotImplemented');
    expect(
      refusal(() =>
        websiteFromXml(document('<IndexDocument><Suffix>index.html</Suffix></IndexDocument><RoutingRules><RoutingRule><Redirect><ReplaceKeyWith>b</ReplaceKeyWith></Redirect></RoutingRule></RoutingRules>'), null),
      ),
    ).toBe('501 NotImplemented');
    expect(refusal(() => websiteFromXml(document('<IndexDocument><Suffix>index.html</Suffix></IndexDocument><Policy/>'), null))).toBe('400 MalformedXML');
    expect(refusal(() => websiteFromXml('<NotificationConfiguration/>', null))).toBe('400 MalformedXML');
    expect(refusal(() => websiteFromXml('<WebsiteConfiguration><IndexDocument>', null))).toBe('400 MalformedXML');
    expect(refusal(() => websiteFromXml('<!DOCTYPE x [<!ENTITY e "index.html">]><WebsiteConfiguration/>', null))).toBe('400 MalformedXML');
  });

  it("answers GetBucketWebsite in S3's XML, its names escaped, without an error document when it has none", () => {
    expect(websiteXml({ indexDocument: 'index.html', errorDocument: '<404>&.html', singlePageApp: true })).toBe(
      document('<IndexDocument><Suffix>index.html</Suffix></IndexDocument><ErrorDocument><Key>&#60;404&#62;&#38;.html</Key></ErrorDocument>'),
    );
    expect(websiteXml({ indexDocument: 'index.html', errorDocument: null, singlePageApp: false })).toBe(document('<IndexDocument><Suffix>index.html</Suffix></IndexDocument>'));
  });

  it("reads and answers FF's API in S3's JSON names, the single-page setting off unless asked, and checks it as S3 does", () => {
    const website: WebsiteConfiguration = websiteFromJson({ indexDocument: { suffix: 'index.html' }, singlePageApp: true });

    expect(website).toEqual({ indexDocument: 'index.html', errorDocument: null, singlePageApp: true });
    expect(websiteJson(website)).toEqual({ indexDocument: { suffix: 'index.html' }, singlePageApp: true });
    expect(websiteJson(websiteFromJson({ indexDocument: { suffix: 'index.html' }, errorDocument: { key: '404.html' } }))).toEqual({
      indexDocument: { suffix: 'index.html' },
      errorDocument: { key: '404.html' },
      singlePageApp: false,
    });
    expect(refusal(() => websiteFromJson({ indexDocument: { suffix: 'docs/index.html' } }))).toBe('400 InvalidArgument');
  });

  it("puts a site's address under the sites' host, on their scheme and port", () => {
    expect(siteUrl(new URL('https://site.ffunc.cloud'), 'shop')).toBe('https://shop.site.ffunc.cloud');
    expect(siteUrl(new URL('http://site.localhost:3004'), 'shop')).toBe('http://shop.site.localhost:3004');
  });
});
