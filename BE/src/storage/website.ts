import { S3Error } from './s3-error';
import { S3_NAMESPACE, escapeXml } from './xml';
import { MalformedXml, XmlElement, childText, childrenNamed, readXml } from './xml-reader';

/**
 * A bucket's website configuration, as S3 keeps one, with one setting of FF's
 * own: the bucket's files are then a site, public to read at its website
 * address alone, its S3 API still signed.
 */
export interface WebsiteConfiguration {
  /** What a folder's path answers, as S3's IndexDocument Suffix: a name without a slash, such as index.html. */
  indexDocument: string;
  /** What a path with no file answers, with 404, as S3's ErrorDocument Key; null for a page of FF's. */
  errorDocument: string | null;
  /**
   * FF's own: a path with no file answers the index document with 200, as
   * CloudFront's custom error response gives a single-page app its routes.
   * S3's XML has no word for it: PutBucketWebsite keeps it as it was.
   */
  singlePageApp: boolean;
}

/** The configuration in FF's API, by S3's JSON names, and FF's own setting. */
export interface WebsiteConfigurationJson {
  indexDocument: { suffix: string };
  errorDocument?: { key: string };
  singlePageApp?: boolean;
}

/** The longest key S3 takes, and so the longest document's name. */
const MAX_KEY = 1024;

const invalidArgument = (message: string) => new S3Error(400, 'InvalidArgument', message);
const malformed = () => new S3Error(400, 'MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema');

/** S3's answer to GetBucketWebsite for a bucket that is no site. */
export const noSuchWebsiteConfiguration = () => new S3Error(404, 'NoSuchWebsiteConfiguration', 'The specified bucket does not have a website configuration');

/** Checks a configuration as S3 checks one; throws S3's error, in its words where it has some. */
export function checkWebsite(website: WebsiteConfiguration): void {
  if (website.indexDocument === '') throw invalidArgument('A value for IndexDocument Suffix must be provided if RedirectAllRequestsTo is empty');
  if (website.indexDocument.includes('/')) throw invalidArgument('The IndexDocument Suffix is not well formed: it must not include a slash');
  if (website.indexDocument.length > MAX_KEY) throw invalidArgument(`The IndexDocument Suffix has ${MAX_KEY} characters at most`);
  if (website.errorDocument !== null && (website.errorDocument === '' || website.errorDocument.length > MAX_KEY)) {
    throw invalidArgument(`The ErrorDocument Key has 1 to ${MAX_KEY} characters`);
  }
}

/** What FF's sites don't do yet, refused as S3 refuses what it doesn't implement. */
function notYet(element: XmlElement | { name: string }): never {
  const what = element.name === 'RedirectAllRequestsTo' ? 'redirecting every request' : 'routing rules';
  throw new S3Error(501, 'NotImplemented', `FF's sites answer their files, an index document and an error document: ${what} come later`);
}

/**
 * PutBucketWebsite's document, read and checked: its index document and its
 * error document; the single-page setting, which S3's XML can't say, kept from
 * the bucket's configuration as it was.
 */
export function websiteFromXml(xml: string, current: WebsiteConfiguration | null): WebsiteConfiguration {
  let root: XmlElement;
  try {
    root = readXml(xml);
  } catch (error) {
    if (error instanceof MalformedXml) throw malformed();
    throw error;
  }
  if (root.name !== 'WebsiteConfiguration') throw malformed();
  for (const element of root.children) {
    if (element.name === 'RedirectAllRequestsTo' || element.name === 'RoutingRules') notYet(element);
    if (element.name !== 'IndexDocument' && element.name !== 'ErrorDocument') throw malformed();
  }
  const [index] = childrenNamed(root, 'IndexDocument');
  const [error] = childrenNamed(root, 'ErrorDocument');
  const website: WebsiteConfiguration = {
    indexDocument: index ? (childText(index, 'Suffix') ?? '') : '',
    errorDocument: error ? (childText(error, 'Key') ?? '') : null,
    singlePageApp: current?.singlePageApp ?? false,
  };
  checkWebsite(website);
  return website;
}

/** GetBucketWebsite's answer, as S3 writes it. */
export function websiteXml(website: WebsiteConfiguration): string {
  const error = website.errorDocument === null ? '' : `<ErrorDocument><Key>${escapeXml(website.errorDocument)}</Key></ErrorDocument>`;
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<WebsiteConfiguration xmlns="${S3_NAMESPACE}"><IndexDocument><Suffix>${escapeXml(website.indexDocument)}</Suffix></IndexDocument>${error}</WebsiteConfiguration>`
  );
}

/** FF's API's configuration, read and checked as S3's. */
export function websiteFromJson(json: WebsiteConfigurationJson): WebsiteConfiguration {
  const website: WebsiteConfiguration = {
    indexDocument: json.indexDocument?.suffix ?? '',
    errorDocument: json.errorDocument ? json.errorDocument.key : null,
    singlePageApp: json.singlePageApp ?? false,
  };
  checkWebsite(website);
  return website;
}

/** The configuration as FF's API answers it. */
export function websiteJson(website: WebsiteConfiguration): Required<Pick<WebsiteConfigurationJson, 'indexDocument' | 'singlePageApp'>> & Pick<WebsiteConfigurationJson, 'errorDocument'> {
  return {
    indexDocument: { suffix: website.indexDocument },
    ...(website.errorDocument === null ? {} : { errorDocument: { key: website.errorDocument } }),
    singlePageApp: website.singlePageApp,
  };
}

/** A site's address: its bucket's name under the sites' host, on their scheme and port. */
export function siteUrl(sites: URL, bucket: string): string {
  const url = new URL(sites);
  url.hostname = `${bucket}.${sites.hostname}`;
  return url.origin;
}
