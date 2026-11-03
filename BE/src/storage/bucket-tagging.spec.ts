import { taggingFromXml, taggingXml } from './bucket-tagging';
import { S3Error } from './s3-error';

const tagging = (tags: string) => `<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${tags}</TagSet></Tagging>`;
const tag = (key: string, value: string) => `<Tag><Key>${key}</Key><Value>${value}</Value></Tag>`;

/** The document's tags, or S3's code and message. */
const read = (xml: string): Record<string, string> | string => {
  try {
    return taggingFromXml(xml);
  } catch (error) {
    if (!(error instanceof S3Error)) throw error;
    return `${error.status} ${error.code}: ${error.message}`;
  }
};

describe("a bucket's tags, in S3's XML", () => {
  it("reads PutBucketTagging's TagSet as sent, spaces and an empty value kept; an empty one, as DeleteBucketTagging, none", () => {
    expect(read(tagging(`${tag('team', 'web')}${tag('cost centre', ' 42 ')}${tag('stage', '')}`))).toEqual({ team: 'web', 'cost centre': ' 42 ', stage: '' });
    expect(read(tagging(''))).toEqual({});
    expect(read(tagging(tag('app/path', 'a=b+c@d:e')))).toEqual({ 'app/path': 'a=b+c@d:e' });
  });

  it('refuses a key twice and a tag AWS would refuse, InvalidTag; a document of another shape, MalformedXML', () => {
    expect(read(tagging(`${tag('team', 'web')}${tag('team', 'shop')}`))).toBe('400 InvalidTag: Cannot provide multiple Tags with the same key');
    expect(read(tagging(tag('aws:createdBy', 'x')))).toBe('400 InvalidTag: The key aws:createdBy starts with aws:, which AWS keeps for its own tags.');
    expect(read(tagging(tag('a&amp;b', 'x')))).toBe("400 InvalidTag: The key a&b holds a character a tag can't: letters, digits, spaces and + - = . _ : / @ only.");
    expect(read(tagging(Array.from({ length: 51 }, (_, n) => tag(`k${n}`, 'v')).join('')))).toBe('400 InvalidTag: A resource has at most 50 tags: these would make it 51.');
    const malformed = '400 MalformedXML: The XML you provided was not well-formed or did not validate against our published schema';
    expect(read('<Tagging><TagSet><Tag><Key>team</Key></Tag></TagSet></Tagging>')).toBe(malformed);
    expect(read('<Tagging><Tag><Key>team</Key><Value>web</Value></Tag></Tagging>')).toBe(malformed);
    expect(read('<Tagging/>')).toBe(malformed);
    expect(read(`<TagSet>${tag('team', 'web')}</TagSet>`)).toBe(malformed);
  });

  it("writes GetBucketTagging's answer, which reads back the same", () => {
    const tags = { team: 'web', 'cost centre': 'a/b c=d' };

    expect(taggingXml(tags)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet><Tag><Key>team</Key><Value>web</Value></Tag><Tag><Key>cost centre</Key><Value>a/b c=d</Value></Tag></TagSet></Tagging>',
    );
    expect(read(taggingXml(tags))).toEqual(tags);
  });
});
