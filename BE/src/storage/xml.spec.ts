import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { S3Error, errorDocument, noSuchBucket } from './s3-error';
import { escapeXml, listBucketsDocument, locationDocument, replacing } from './xml';

/** The front door's own documents as S3 writes them, which ff local's S3 writes too. */
const { documents } = JSON.parse(readFileSync(join(__dirname, 's3-examples.json'), 'utf8')) as {
  documents: {
    escaped: { text: string; xml: string };
    error: { status: number; code: string; message: string; resource: string; requestId: string; document: string };
    listBuckets: { owner: string; buckets: Array<{ name: string; createdAt: string }>; region: string; document: string };
    location: { region: string; document: string };
  };
};

describe("the front door's own XML", () => {
  it('escapes what would break the document', () => {
    expect(escapeXml(documents.escaped.text)).toBe(documents.escaped.xml);
  });

  it("an error, in S3's document: its code, message, resource and request", () => {
    const { status, code, message, resource, requestId, document } = documents.error;

    expect(errorDocument(new S3Error(status, code, message), requestId, resource)).toBe(document);
    expect(noSuchBucket()).toMatchObject({ status, code, message });
  });

  it("ListBuckets' answer and GetBucketLocation's, as S3 writes them", () => {
    const { owner, buckets, region, document } = documents.listBuckets;

    expect(listBucketsDocument(owner, buckets.map(({ name, createdAt }) => ({ name, createdAt: new Date(createdAt) })), region)).toBe(document);
    expect(locationDocument(documents.location.region)).toBe(documents.location.document);
  });
});

describe("the store's name for a bucket, replaced in its answers", () => {
  const STORE = 'ff-0123456789abcdef01234567';
  const replaced = (pieces: string[]) => text(Readable.from(pieces.map((piece) => Buffer.from(piece))).pipe(replacing(STORE, 'photos')));

  it('everywhere, a name split between two chunks too', async () => {
    const document = `<ListBucketResult><Name>${STORE}</Name><Contents><Key>a</Key></Contents></ListBucketResult><Resource>/${STORE}/a</Resource>`;
    const pieces: string[] = [];
    for (let at = 0; at < document.length; at += 5) pieces.push(document.slice(at, at + 5));

    expect(await replaced(pieces)).toBe('<ListBucketResult><Name>photos</Name><Contents><Key>a</Key></Contents></ListBucketResult><Resource>/photos/a</Resource>');
  });

  it("and nothing else: an answer without it is the store's, byte for byte", async () => {
    expect(await replaced(['<Key>ff-0123456789abcdef0123456</Key>', '<Key>ff-', '012</Key>'])).toBe('<Key>ff-0123456789abcdef0123456</Key><Key>ff-012</Key>');
  });
});
