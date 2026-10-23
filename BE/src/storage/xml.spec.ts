import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { errorDocument, noSuchBucket } from './s3-error';
import { escapeXml, listBucketsDocument, locationDocument, replacing } from './xml';

describe("the front door's own XML", () => {
  it('escapes what would break the document', () => {
    expect(escapeXml(`a<b>&"c'`)).toBe('a&#60;b&#62;&#38;&#34;c&#39;');
  });

  it("an error, in S3's document: its code, message, resource and request", () => {
    expect(errorDocument(noSuchBucket(), 'REQ1', '/photos/a&b')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message><Resource>/photos/a&#38;b</Resource><RequestId>REQ1</RequestId></Error>',
    );
  });

  it("ListBuckets' answer and GetBucketLocation's, as S3 writes them", () => {
    expect(listBucketsDocument('000000000001', [{ name: 'photos', createdAt: new Date('2026-10-23T06:00:00Z') }], 'tn-tunis-1')).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>000000000001</ID><DisplayName>000000000001</DisplayName></Owner>' +
        '<Buckets><Bucket><Name>photos</Name><CreationDate>2026-10-23T06:00:00.000Z</CreationDate><BucketRegion>tn-tunis-1</BucketRegion></Bucket></Buckets></ListAllMyBucketsResult>',
    );
    expect(locationDocument('tn-tunis-1')).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">tn-tunis-1</LocationConstraint>');
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
