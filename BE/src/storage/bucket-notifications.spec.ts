/**
 * A bucket's notifications' tests. S3's records, the keys in them, which rule
 * an event goes by, the test event and GetBucketNotificationConfiguration's
 * documents are bucket-event-examples.json's, which ff local's buckets read
 * too; the configurations' checks stay here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { S3Error } from './s3-error';
import {
  NotificationRule,
  S3EventFacts,
  checkRules,
  eventKey,
  nextSequencer,
  ruleFor,
  rulesFromJson,
  rulesFromXml,
  rulesJson,
  rulesXml,
  s3EventRecord,
  testEvent,
} from './bucket-notifications';

const table = JSON.parse(readFileSync(join(__dirname, 'bucket-event-examples.json'), 'utf8')) as {
  records: Array<{ name: string; facts: Omit<S3EventFacts, 'time'> & { time: string }; record: Record<string, unknown> }>;
  keys: Array<{ key: string; inEvent: string }>;
  rules: NotificationRule[];
  matches: Array<{ eventName: string; key: string; rule: string | null }>;
  testEvent: { bucket: string; requestId: string; time: string; event: Record<string, string> };
  documents: Array<{ name: string; rules: NotificationRule[]; xml: string }>;
};

const FUNCTION_ARN = 'arn:aws:lambda:tn-tunis-1:000000000001:function:thumbnails';
const QUEUE_ARN = 'arn:aws:sqs:tn-tunis-1:000000000001:uploads';
const rule = (values: Partial<NotificationRule> = {}): NotificationRule => ({
  id: 'thumbs',
  target: 'function',
  arn: FUNCTION_ARN,
  events: ['s3:ObjectCreated:*'],
  prefix: null,
  suffix: null,
  ...values,
});

/** S3's error, as its code and message. */
function refusal(check: () => unknown): string {
  try {
    check();
  } catch (error) {
    if (error instanceof S3Error) return `${error.status} ${error.code}: ${error.message}`;
    throw error;
  }
  return 'accepted';
}

describe("a bucket's notification configuration, as S3's XML", () => {
  it("reads S3's documented document: queues and Lambda functions, their events and key filters, an ID made for one given none", () => {
    const rules = rulesFromXml(`<?xml version="1.0" encoding="UTF-8"?>
<NotificationConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <QueueConfiguration>
    <Id>uploads</Id>
    <Queue>${QUEUE_ARN}</Queue>
    <Event>s3:ObjectCreated:Put</Event>
    <Event>s3:ObjectCreated:CompleteMultipartUpload</Event>
    <Filter><S3Key><FilterRule><Name>Prefix</Name><Value>incoming/</Value></FilterRule><FilterRule><Name>suffix</Name><Value>.csv</Value></FilterRule></S3Key></Filter>
  </QueueConfiguration>
  <CloudFunctionConfiguration>
    <CloudFunction>${FUNCTION_ARN}</CloudFunction>
    <Event>s3:ObjectRemoved:*</Event>
  </CloudFunctionConfiguration>
</NotificationConfiguration>`);

    expect(rules).toEqual([
      { id: 'uploads', target: 'queue', arn: QUEUE_ARN, events: ['s3:ObjectCreated:Put', 's3:ObjectCreated:CompleteMultipartUpload'], prefix: 'incoming/', suffix: '.csv' },
      { id: expect.stringMatching(/^[A-Za-z0-9+/=]{40,}$/), target: 'function', arn: FUNCTION_ARN, events: ['s3:ObjectRemoved:*'], prefix: null, suffix: null },
    ]);
    expect(rulesFromXml('<NotificationConfiguration/>')).toEqual([]);
  });

  it("writes them back as S3 answers them, which reads back the same", () => {
    const [{ rules, xml }] = table.documents;

    expect(table.documents.map((document) => rulesXml(document.rules))).toEqual(table.documents.map((document) => document.xml));
    expect(rulesFromXml(xml)).toEqual([rules[1], rules[0]]);
    expect(table.documents.map((document) => rulesFromXml(document.xml).length)).toEqual([2, 0]);
  });

  it.each([
    ['<NotificationConfiguration><TopicConfiguration><Topic>t</Topic><Event>s3:ObjectCreated:*</Event></TopicConfiguration></NotificationConfiguration>', "400 InvalidArgument: FF's buckets notify functions and queues: SNS topics come later"],
    ['<NotificationConfiguration><EventBridgeConfiguration/></NotificationConfiguration>', "400 InvalidArgument: FF's buckets notify functions and queues: EventBridge comes later"],
    ['<NotificationConfiguration><QueueConfiguration><Event>s3:ObjectCreated:*</Event></QueueConfiguration></NotificationConfiguration>', '400 MalformedXML: The XML you provided was not well-formed or did not validate against our published schema'],
    ['<NotificationConfiguration><Other/></NotificationConfiguration>', '400 MalformedXML: The XML you provided was not well-formed or did not validate against our published schema'],
    ['<Configuration/>', '400 MalformedXML: The XML you provided was not well-formed or did not validate against our published schema'],
    ['<NotificationConfiguration>', '400 MalformedXML: The XML you provided was not well-formed or did not validate against our published schema'],
    [
      `<NotificationConfiguration><QueueConfiguration><Queue>${QUEUE_ARN}</Queue><Event>s3:ObjectCreated:*</Event><Filter><S3Key><FilterRule><Name>contains</Name><Value>x</Value></FilterRule></S3Key></Filter></QueueConfiguration></NotificationConfiguration>`,
      '400 InvalidArgument: Invalid filter name: contains. A filter rule is a prefix or a suffix',
    ],
    [
      `<NotificationConfiguration><QueueConfiguration><Queue>${QUEUE_ARN}</Queue><Event>s3:ObjectCreated:*</Event><Filter><S3Key><FilterRule><Name>prefix</Name><Value>a</Value></FilterRule><FilterRule><Name>prefix</Name><Value>b</Value></FilterRule></S3Key></Filter></QueueConfiguration></NotificationConfiguration>`,
      '400 InvalidArgument: Cannot specify more than one prefix rule in a filter',
    ],
  ])('refuses %j in S3\'s words', (xml, problem) => {
    expect(refusal(() => rulesFromXml(xml))).toBe(problem);
  });
});

describe("a bucket's notification configuration, in FF's API's JSON, S3's names", () => {
  it('reads and writes the same rules, in camelCase, an ID made for one given none', () => {
    const rules = [rule({ prefix: 'images/' }), rule({ id: 'q', target: 'queue', arn: QUEUE_ARN, events: ['s3:ObjectRemoved:*'] })];

    const json = rulesJson(rules);

    expect(json).toEqual({
      lambdaFunctionConfigurations: [{ id: 'thumbs', lambdaFunctionArn: FUNCTION_ARN, events: ['s3:ObjectCreated:*'], filter: { key: { filterRules: [{ name: 'prefix', value: 'images/' }] } } }],
      queueConfigurations: [{ id: 'q', queueArn: QUEUE_ARN, events: ['s3:ObjectRemoved:*'] }],
    });
    expect(rulesFromJson(json)).toEqual([rules[1], rules[0]]);
    expect(rulesFromJson({ queueConfigurations: [{ queueArn: QUEUE_ARN, events: ['s3:ObjectCreated:*'] }] })[0].id).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    expect(rulesFromJson({})).toEqual([]);
  });
});

describe('the rules S3 takes', () => {
  it('takes rules no event can match twice: other prefixes, other suffixes, other events', () => {
    expect(() =>
      checkRules([
        rule({ id: 'a', prefix: 'images/' }),
        rule({ id: 'b', prefix: 'docs/' }),
        rule({ id: 'c', prefix: 'videos/', suffix: '.mp4' }),
        rule({ id: 'd', prefix: 'videos/', suffix: '.webm' }),
        rule({ id: 'e', events: ['s3:ObjectRemoved:*'] }),
      ]),
    ).not.toThrow();
  });

  it.each([
    [[rule({ id: 'a' }), rule({ id: 'b', target: 'queue', arn: QUEUE_ARN })], 'the same events, no filter'],
    [[rule({ id: 'a', prefix: 'images/' }), rule({ id: 'b', prefix: 'images/thumbs/' })], 'a prefix of the other'],
    [[rule({ id: 'a', suffix: '.jpg' }), rule({ id: 'b', suffix: 'cat.jpg', prefix: 'x' })], 'a suffix of the other, a prefix on one'],
    [[rule({ id: 'a', events: ['s3:ObjectCreated:Put'] }), rule({ id: 'b', events: ['s3:ObjectCreated:*'] })], 'a kind and its wildcard'],
  ])('refuses two rules one event could match, as ambiguous: %#, %s', (rules) => {
    expect(refusal(() => checkRules(rules))).toBe(
      '400 InvalidArgument: Configuration is ambiguously defined. Cannot have overlapping suffixes in two rules if the prefixes are overlapping for the same event type.',
    );
  });

  it('refuses an event S3 sends that FF doesn\'t, an ID twice, an empty filter value, and more than 100 rules', () => {
    expect(refusal(() => checkRules([rule({ events: ['s3:ObjectTagging:*'] })]))).toMatch(/^400 InvalidArgument: The event is not supported for notifications: s3:ObjectTagging:\*/);
    expect(refusal(() => checkRules([rule({ prefix: 'a' }), rule({ prefix: 'b' })]))).toBe('400 InvalidArgument: Two configurations have the ID thumbs: each needs its own');
    expect(refusal(() => checkRules([rule({ prefix: '' })]))).toBe("400 InvalidArgument: A filter's value has 1 to 1024 characters");
    expect(refusal(() => checkRules([rule({ events: [] })]))).toBe('400 InvalidArgument: A configuration names at least one event');
    expect(refusal(() => checkRules(Array.from({ length: 101 }, (_, n) => rule({ id: `r${n}`, prefix: `p${n}/` }))))).toBe('400 InvalidArgument: A bucket has 100 notification configurations at most');
  });
});

describe('an event, as S3 sends it', () => {
  it('goes by the rule whose events and filter name it', () => {
    const goesBy = ({ eventName, key }: { eventName: string; key: string }) => ruleFor(table.rules, eventName, key)?.id ?? null;

    expect(table.matches.map((match) => [match.eventName, match.key, goesBy(match)])).toEqual(table.matches.map((match) => [match.eventName, match.key, match.rule]));
    expect(table.matches).toHaveLength(5);
  });

  it("names its object's key form-encoded, as S3 writes it: a space a +, a slash and S3's other characters escaped", () => {
    expect(table.keys.map(({ key }) => eventKey(key))).toEqual(table.keys.map(({ inEvent }) => inEvent));
    expect(table.keys).toHaveLength(3);
  });

  it('numbers events with an increasing sequencer, two in one millisecond too', () => {
    const [a, b, c] = [nextSequencer(1_792_800_000_000), nextSequencer(1_792_800_000_000), nextSequencer(1_792_800_000_001)];

    expect([a, b, c].every((sequencer) => /^[0-9A-F]{18}$/.test(sequencer))).toBe(true);
    expect([a < b, b < c]).toEqual([true, true]);
  });

  it("is S3's record, version 2.1, a removed object's without its size and ETag; and S3's test event", () => {
    const records = table.records.map(({ facts }) => s3EventRecord({ ...facts, time: new Date(facts.time) }));

    expect(records).toEqual(table.records.map(({ record }) => record));
    expect(table.records.map(({ facts }) => facts.eventName)).toEqual(['ObjectRemoved:Delete', 'ObjectCreated:Put']);
    const { bucket, requestId, time, event } = table.testEvent;
    expect(testEvent(bucket, requestId, new Date(time))).toEqual(event);
  });
});
