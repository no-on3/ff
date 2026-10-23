import { Transform } from 'node:stream';

/** S3's namespace, which its answers declare. */
export const S3_NAMESPACE = 'http://s3.amazonaws.com/doc/2006-03-01/';

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** Text made safe in an XML element or attribute. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** One bucket in ListBuckets' answer. */
export interface ListedBucket {
  name: string;
  createdAt: Date;
}

/** ListBuckets' answer: the account's buckets, by name, as S3 lists them, and the account as their owner. */
export function listBucketsDocument(ownerId: string, buckets: ListedBucket[], region: string): string {
  const items = buckets
    .map(
      (bucket) =>
        `<Bucket><Name>${escapeXml(bucket.name)}</Name><CreationDate>${bucket.createdAt.toISOString()}</CreationDate>` +
        `<BucketRegion>${escapeXml(region)}</BucketRegion></Bucket>`,
    )
    .join('');
  return (
    `${XML_DECLARATION}<ListAllMyBucketsResult xmlns="${S3_NAMESPACE}"><Owner><ID>${escapeXml(ownerId)}</ID><DisplayName>${escapeXml(ownerId)}</DisplayName></Owner>` +
    `<Buckets>${items}</Buckets></ListAllMyBucketsResult>`
  );
}

/** GetBucketLocation's answer: FF's region. */
export function locationDocument(region: string): string {
  return `${XML_DECLARATION}<LocationConstraint xmlns="${S3_NAMESPACE}">${escapeXml(region)}</LocationConstraint>`;
}

/**
 * Every occurrence of `from` replaced with `to` as the bytes stream past, a
 * match split between two chunks included: the store's name for a bucket
 * becomes the customer's in the store's answers, whatever their size. Only the
 * last bytes that could start a match wait for the next chunk.
 */
export function replacing(from: string, to: string): Transform {
  const needle = Buffer.from(from, 'utf8');
  const replacement = Buffer.from(to, 'utf8');
  let carry = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const parts: Buffer[] = [];
      let start = 0;
      for (let at = data.indexOf(needle, start); at !== -1; at = data.indexOf(needle, start)) {
        parts.push(data.subarray(start, at), replacement);
        start = at + needle.length;
      }
      const kept = Math.max(start, data.length - (needle.length - 1));
      parts.push(data.subarray(start, kept));
      carry = Buffer.from(data.subarray(kept));
      done(null, Buffer.concat(parts));
    },
    flush(done) {
      done(null, carry);
    },
  });
}
