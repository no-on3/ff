import { randomUUID } from 'node:crypto';
import { S3Error } from './s3-error';
import { S3_NAMESPACE, escapeXml } from './xml';
import { MalformedXml, XmlElement, childText, childrenNamed, readXml } from './xml-reader';

/** Where a rule's events go: a function of the account, called without waiting, as S3 calls Lambda; or a queue of it, a message each. */
export type NotificationTarget = 'function' | 'queue';

/** One of a bucket's notification configurations, as S3 keeps them: its ID, its destination, its events, and its key's filter. */
export interface NotificationRule {
  id: string;
  target: NotificationTarget;
  /** The destination's ARN: a function's (arn:aws:lambda:…) or a queue's (arn:aws:sqs:…). */
  arn: string;
  /** S3's event types, as given: s3:ObjectCreated:* or one of its kinds, s3:ObjectRemoved:* or one of its. */
  events: string[];
  prefix: string | null;
  suffix: string | null;
}

/** The event types FF's buckets send, as S3 names them. A bucket isn't versioned, so DeleteMarkerCreated is taken but never sent. */
export const EVENT_TYPES = [
  's3:ObjectCreated:*',
  's3:ObjectCreated:Put',
  's3:ObjectCreated:Post',
  's3:ObjectCreated:Copy',
  's3:ObjectCreated:CompleteMultipartUpload',
  's3:ObjectRemoved:*',
  's3:ObjectRemoved:Delete',
  's3:ObjectRemoved:DeleteMarkerCreated',
] as const;

/** The most configurations a bucket keeps. */
export const MAX_RULES = 100;
/** The longest ID and filter value S3 takes. */
const MAX_ID = 255;
const MAX_FILTER_VALUE = 1024;

const invalidArgument = (message: string) => new S3Error(400, 'InvalidArgument', message);
const malformed = () => new S3Error(400, 'MalformedXML', 'The XML you provided was not well-formed or did not validate against our published schema');

/** An ID for a configuration given none, as S3 makes one: a random UUID, in base64. */
const newId = (): string => Buffer.from(randomUUID()).toString('base64');

/** Whether two event types name an event in common: equal, or one the other's wildcard. */
function typesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const covers = (wild: string, other: string) => wild.endsWith(':*') && other.startsWith(wild.slice(0, -1));
  return covers(a, b) || covers(b, a);
}

/**
 * Checks a bucket's rules as S3 checks a configuration: S3's event types,
 * prefix and suffix filters, IDs unique, and no two rules that could both take
 * one event, which S3 refuses as ambiguous, so that each event goes to one
 * destination. Throws S3's error, in its words where it has some.
 */
export function checkRules(rules: NotificationRule[]): void {
  if (rules.length > MAX_RULES) throw invalidArgument(`A bucket has ${MAX_RULES} notification configurations at most`);
  const ids = new Set<string>();
  for (const rule of rules) {
    if (rule.id.length === 0 || rule.id.length > MAX_ID) throw invalidArgument(`A configuration's ID has 1 to ${MAX_ID} characters`);
    if (ids.has(rule.id)) throw invalidArgument(`Two configurations have the ID ${rule.id}: each needs its own`);
    ids.add(rule.id);
    if (rule.events.length === 0) throw invalidArgument('A configuration names at least one event');
    for (const event of rule.events) {
      if (!(EVENT_TYPES as readonly string[]).includes(event)) {
        throw invalidArgument(`The event is not supported for notifications: ${event}. FF's buckets send ${EVENT_TYPES.join(', ')}`);
      }
    }
    for (const value of [rule.prefix, rule.suffix]) {
      if (value !== null && (value.length === 0 || value.length > MAX_FILTER_VALUE)) throw invalidArgument(`A filter's value has 1 to ${MAX_FILTER_VALUE} characters`);
    }
  }
  for (const [index, a] of rules.entries()) {
    for (const b of rules.slice(index + 1)) {
      const events = a.events.some((x) => b.events.some((y) => typesOverlap(x, y)));
      const prefixes = !a.prefix || !b.prefix || a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix);
      const suffixes = !a.suffix || !b.suffix || a.suffix.endsWith(b.suffix) || b.suffix.endsWith(a.suffix);
      if (events && prefixes && suffixes) {
        throw invalidArgument('Configuration is ambiguously defined. Cannot have overlapping suffixes in two rules if the prefixes are overlapping for the same event type.');
      }
    }
  }
}

/** A filter's rules, as S3's XML or its API's JSON gives them: prefix and suffix, once each, by name in any case. */
function filterOf(rules: Array<{ name: string; value: string }>): { prefix: string | null; suffix: string | null } {
  const filter: { prefix: string | null; suffix: string | null } = { prefix: null, suffix: null };
  for (const { name, value } of rules) {
    const which = name.toLowerCase();
    if (which !== 'prefix' && which !== 'suffix') throw invalidArgument(`Invalid filter name: ${name}. A filter rule is a prefix or a suffix`);
    if (filter[which] !== null) throw invalidArgument(`Cannot specify more than one ${which} rule in a filter`);
    filter[which] = value;
  }
  return filter;
}

/**
 * The rules of PutBucketNotificationConfiguration's document: its
 * QueueConfiguration and CloudFunctionConfiguration elements, S3's XML names
 * for queues and Lambda functions. SNS topics and EventBridge are refused,
 * saying so; an empty configuration removes every rule.
 */
export function rulesFromXml(xml: string): NotificationRule[] {
  let root: XmlElement;
  try {
    root = readXml(xml);
  } catch (error) {
    if (error instanceof MalformedXml) throw malformed();
    throw error;
  }
  if (root.name !== 'NotificationConfiguration') throw malformed();
  return root.children.map((element) => {
    if (element.name === 'TopicConfiguration') throw invalidArgument("FF's buckets notify functions and queues: SNS topics come later");
    if (element.name === 'EventBridgeConfiguration') throw invalidArgument("FF's buckets notify functions and queues: EventBridge comes later");
    const target = element.name === 'QueueConfiguration' ? 'queue' : element.name === 'CloudFunctionConfiguration' ? 'function' : undefined;
    if (!target) throw malformed();
    const arn = childText(element, target === 'queue' ? 'Queue' : 'CloudFunction');
    if (!arn) throw malformed();
    const [filter] = childrenNamed(element, 'Filter');
    const [key] = filter ? childrenNamed(filter, 'S3Key') : [];
    const filterRules = (key ? childrenNamed(key, 'FilterRule') : []).map((rule) => ({ name: childText(rule, 'Name') ?? '', value: childText(rule, 'Value') ?? '' }));
    return {
      id: childText(element, 'Id') || newId(),
      target,
      arn,
      events: childrenNamed(element, 'Event').map((event) => event.text.trim()),
      ...filterOf(filterRules),
    };
  });
}

const filterXml = (rule: NotificationRule): string => {
  const parts = [
    ...(rule.prefix !== null ? [`<FilterRule><Name>prefix</Name><Value>${escapeXml(rule.prefix)}</Value></FilterRule>`] : []),
    ...(rule.suffix !== null ? [`<FilterRule><Name>suffix</Name><Value>${escapeXml(rule.suffix)}</Value></FilterRule>`] : []),
  ];
  return parts.length ? `<Filter><S3Key>${parts.join('')}</S3Key></Filter>` : '';
};

/** GetBucketNotificationConfiguration's answer: the queues' configurations, then the functions', in S3's XML. */
export function rulesXml(rules: NotificationRule[]): string {
  const element = (rule: NotificationRule) => {
    const [name, arn] = rule.target === 'queue' ? ['QueueConfiguration', 'Queue'] : ['CloudFunctionConfiguration', 'CloudFunction'];
    const events = rule.events.map((event) => `<Event>${escapeXml(event)}</Event>`).join('');
    return `<${name}><Id>${escapeXml(rule.id)}</Id><${arn}>${escapeXml(rule.arn)}</${arn}>${events}${filterXml(rule)}</${name}>`;
  };
  const ordered = [...rules.filter((rule) => rule.target === 'queue'), ...rules.filter((rule) => rule.target === 'function')];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<NotificationConfiguration xmlns="${S3_NAMESPACE}">${ordered.map(element).join('')}</NotificationConfiguration>`;
}

/** A configuration's key filter, as S3's API names it in JSON. */
export interface KeyFilterJson {
  key: { filterRules: Array<{ name: string; value: string }> };
}

/** A bucket's notification configuration, as S3's API names it in JSON, which FF's API answers and takes. */
export interface NotificationConfigurationJson {
  lambdaFunctionConfigurations: Array<{ id?: string; lambdaFunctionArn: string; events: string[]; filter?: KeyFilterJson }>;
  queueConfigurations: Array<{ id?: string; queueArn: string; events: string[]; filter?: KeyFilterJson }>;
}

/** The rules of FF's API's body, as of S3's document. */
export function rulesFromJson(json: Partial<NotificationConfigurationJson>): NotificationRule[] {
  const filter = (given?: KeyFilterJson) => filterOf(given?.key?.filterRules ?? []);
  return [
    ...(json.queueConfigurations ?? []).map((rule) => ({ id: rule.id || newId(), target: 'queue' as const, arn: rule.queueArn, events: rule.events, ...filter(rule.filter) })),
    ...(json.lambdaFunctionConfigurations ?? []).map((rule) => ({
      id: rule.id || newId(),
      target: 'function' as const,
      arn: rule.lambdaFunctionArn,
      events: rule.events,
      ...filter(rule.filter),
    })),
  ];
}

/** The rules as FF's API answers them, in S3's JSON names. */
export function rulesJson(rules: NotificationRule[]): NotificationConfigurationJson {
  const filter = (rule: NotificationRule): { filter?: KeyFilterJson } => {
    const filterRules = [
      ...(rule.prefix !== null ? [{ name: 'prefix', value: rule.prefix }] : []),
      ...(rule.suffix !== null ? [{ name: 'suffix', value: rule.suffix }] : []),
    ];
    return filterRules.length ? { filter: { key: { filterRules } } } : {};
  };
  return {
    lambdaFunctionConfigurations: rules
      .filter((rule) => rule.target === 'function')
      .map((rule) => ({ id: rule.id, lambdaFunctionArn: rule.arn, events: rule.events, ...filter(rule) })),
    queueConfigurations: rules.filter((rule) => rule.target === 'queue').map((rule) => ({ id: rule.id, queueArn: rule.arn, events: rule.events, ...filter(rule) })),
  };
}

/** The rule an event of that name, for that key, goes by: the bucket's checked rules can't name it twice. */
export function ruleFor(rules: NotificationRule[], eventName: string, key: string): NotificationRule | undefined {
  return rules.find(
    (rule) =>
      rule.events.some((type) => typesOverlap(type, `s3:${eventName}`)) && (rule.prefix === null || key.startsWith(rule.prefix)) && (rule.suffix === null || key.endsWith(rule.suffix)),
  );
}

/** An object's key in S3's events: form-encoded, as S3 writes it, a space a "+" and a slash %2F. */
export const eventKey = (key: string): string =>
  encodeURIComponent(key)
    .replace(/[!'()~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%20/g, '+');

let lastSequencer = 0n;
/** A sequencer, as S3 gives each event: hexadecimal, increasing, so that two events of one key are put in order by it. */
export function nextSequencer(now = Date.now()): string {
  const candidate = BigInt(now) * 65_536n;
  lastSequencer = candidate > lastSequencer ? candidate : lastSequencer + 1n;
  return lastSequencer.toString(16).toUpperCase().padStart(18, '0');
}

/** What an event says, from the request that made it. */
export interface S3EventFacts {
  region: string;
  /** ObjectCreated:Put, ObjectRemoved:Delete…: S3's name, without its s3: prefix. */
  eventName: string;
  time: Date;
  /** The access key that made the request. */
  principalId: string;
  sourceIp: string;
  requestId: string;
  bucket: { name: string; accountId: string };
  /** The key as stored, not encoded; a created object's size and ETag, without its quotes. */
  object: { key: string; size?: number; eTag?: string };
  configurationId: string;
  sequencer: string;
}

/** One record of S3's event, as S3 sends it to Lambda and SQS (its version 2.1). */
export function s3EventRecord(facts: S3EventFacts): Record<string, unknown> {
  return {
    eventVersion: '2.1',
    eventSource: 'aws:s3',
    awsRegion: facts.region,
    eventTime: facts.time.toISOString(),
    eventName: facts.eventName,
    userIdentity: { principalId: `AWS:${facts.principalId}` },
    requestParameters: { sourceIPAddress: facts.sourceIp },
    responseElements: { 'x-amz-request-id': facts.requestId, 'x-amz-id-2': facts.requestId },
    s3: {
      s3SchemaVersion: '1.0',
      configurationId: facts.configurationId,
      bucket: { name: facts.bucket.name, ownerIdentity: { principalId: facts.bucket.accountId }, arn: `arn:aws:s3:::${facts.bucket.name}` },
      object: {
        key: eventKey(facts.object.key),
        ...(facts.object.size !== undefined ? { size: facts.object.size } : {}),
        ...(facts.object.eTag !== undefined ? { eTag: facts.object.eTag } : {}),
        sequencer: facts.sequencer,
      },
    },
  };
}

/** The message S3 sends a queue when a configuration names it, so that its readers may see it works. */
export function testEvent(bucket: string, requestId: string, time: Date): Record<string, string> {
  return { Service: 'Amazon S3', Event: 's3:TestEvent', Time: time.toISOString(), Bucket: bucket, RequestId: requestId, HostId: requestId };
}
