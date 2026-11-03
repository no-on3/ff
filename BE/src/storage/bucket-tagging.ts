import { tagsProblem } from '../tags/tag-rules';
import { S3Error, malformedXml } from './s3-error';
import { S3_NAMESPACE, XML_DECLARATION, escapeXml } from './xml';
import { XmlElement, childrenNamed, readS3Document } from './xml-reader';

export const invalidTag = (message: string) => new S3Error(400, 'InvalidTag', message);

/** S3's answer to GetBucketTagging for a bucket without tags. */
export const noSuchTagSet = () => new S3Error(404, 'NoSuchTagSet', 'The TagSet does not exist');

/**
 * The tags of a list of S3's Tag elements, each a Key and a Value, kept as
 * sent: a key twice, or a tag AWS would refuse, InvalidTag, as S3 answers.
 */
export function tagsOf(tagElements: XmlElement[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const tag of tagElements) {
    const [key] = childrenNamed(tag, 'Key');
    const [value] = childrenNamed(tag, 'Value');
    if (tag.name !== 'Tag' || !key || !value || tag.children.length !== 2) throw malformedXml();
    if (Object.hasOwn(tags, key.text)) throw invalidTag('Cannot provide multiple Tags with the same key');
    tags[key.text] = value.text;
  }
  const problem = tagsProblem({}, tags);
  if (problem && tagElements.length > 0) throw invalidTag(problem);
  return tags;
}

/** PutBucketTagging's document, its TagSet read: none there removes the bucket's tags, as S3 does. */
export function taggingFromXml(xml: string): Record<string, string> {
  const root = readS3Document(xml, 'Tagging');
  const [tagSet, ...more] = root.children;
  if (!tagSet || tagSet.name !== 'TagSet' || more.length > 0) throw malformedXml();
  return tagsOf(tagSet.children);
}

/** GetBucketTagging's answer: the bucket's tags in S3's XML, by key. */
export function taggingXml(tags: Record<string, string>): string {
  const tagSet = Object.entries(tags)
    .map(([key, value]) => `<Tag><Key>${escapeXml(key)}</Key><Value>${escapeXml(value)}</Value></Tag>`)
    .join('');
  return `${XML_DECLARATION}<Tagging xmlns="${S3_NAMESPACE}"><TagSet>${tagSet}</TagSet></Tagging>`;
}
