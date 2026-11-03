import { S3Error, malformedXml } from './s3-error';
import { S3_NAMESPACE, XML_DECLARATION } from './xml';
import { readS3Document } from './xml-reader';

/** S3's largest bucket policy, in bytes. */
export const MAX_POLICY_BYTES = 20 * 1024;

/**
 * A bucket's public access block, as S3 keeps one: four switches, each false
 * when the document leaves it out.
 */
export interface PublicAccessBlock {
  blockPublicAcls: boolean;
  ignorePublicAcls: boolean;
  blockPublicPolicy: boolean;
  restrictPublicBuckets: boolean;
}

/** Each switch by S3's XML name, in S3's order. */
const SWITCHES: Array<[string, keyof PublicAccessBlock]> = [
  ['BlockPublicAcls', 'blockPublicAcls'],
  ['IgnorePublicAcls', 'ignorePublicAcls'],
  ['BlockPublicPolicy', 'blockPublicPolicy'],
  ['RestrictPublicBuckets', 'restrictPublicBuckets'],
];

const malformedPolicy = (message: string) => new S3Error(400, 'MalformedPolicy', message);

/** S3's answer to GetBucketPolicy for a bucket without one. */
export const noSuchBucketPolicy = () => new S3Error(404, 'NoSuchBucketPolicy', 'The bucket policy does not exist');

/** S3's answer to GetPublicAccessBlock for a bucket without one. */
export const noSuchPublicAccessBlock = () => new S3Error(404, 'NoSuchPublicAccessBlockConfiguration', 'The public access block configuration was not found');

/**
 * PutBucketPolicy's document, checked for its form as S3 checks it: JSON, an
 * object, with a Statement, within S3's 20 KB. Kept as sent, so that it reads
 * back as it was written.
 */
export function policyFrom(text: string): string {
  if (Buffer.byteLength(text) > MAX_POLICY_BYTES) throw malformedPolicy(`Policies must be no larger than ${MAX_POLICY_BYTES} bytes`);
  let policy: unknown;
  try {
    policy = JSON.parse(text);
  } catch {
    policy = undefined;
  }
  if (!text.trimStart().startsWith('{') || typeof policy !== 'object' || policy === null) {
    throw malformedPolicy("Policies must be valid JSON and the first byte must be '{'");
  }
  if (!('Statement' in policy)) throw malformedPolicy('Missing required field Statement');
  return text;
}

/** PutPublicAccessBlock's document: each switch at most once, true or false, any left out false, as S3 reads it. */
export function publicAccessBlockFromXml(xml: string): PublicAccessBlock {
  const root = readS3Document(xml, 'PublicAccessBlockConfiguration');
  const block: PublicAccessBlock = { blockPublicAcls: false, ignorePublicAcls: false, blockPublicPolicy: false, restrictPublicBuckets: false };
  const seen = new Set<string>();
  for (const child of root.children) {
    const field = SWITCHES.find(([name]) => name === child.name)?.[1];
    const value = child.text.trim();
    if (!field || seen.has(child.name) || (value !== 'true' && value !== 'false')) throw malformedXml();
    seen.add(child.name);
    block[field] = value === 'true';
  }
  return block;
}

/** GetPublicAccessBlock's answer: the four switches in S3's XML. */
export function publicAccessBlockXml(block: PublicAccessBlock): string {
  const switches = SWITCHES.map(([name, field]) => `<${name}>${block[field]}</${name}>`).join('');
  return `${XML_DECLARATION}<PublicAccessBlockConfiguration xmlns="${S3_NAMESPACE}">${switches}</PublicAccessBlockConfiguration>`;
}
