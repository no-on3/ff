import { describe, expect, it } from 'vitest';
import { configurationBody, emptyNotificationForm, entriesOf, entryOf, notificationText } from './bucket-notifications';

const FUNCTION_ARN = 'arn:aws:lambda:tn-tunis-1:000000000001:function:thumbnails';
const QUEUE_ARN = 'arn:aws:sqs:tn-tunis-1:000000000001:removals';
const configuration = {
  lambdaFunctionConfigurations: [
    {
      id: 'thumbs',
      lambdaFunctionArn: FUNCTION_ARN,
      events: ['s3:ObjectCreated:*'],
      filter: { key: { filterRules: [{ name: 'prefix', value: 'images/' }, { name: 'suffix', value: '.jpg' }] } },
    },
  ],
  queueConfigurations: [{ id: 'removals', queueArn: QUEUE_ARN, events: ['s3:ObjectRemoved:*'] }],
};

describe("a bucket's notifications, as the console says them", () => {
  it('reads the API\'s configuration as entries, the functions\' first, and says each in words', () => {
    const entries = entriesOf(configuration);

    expect(entries).toEqual([
      { id: 'thumbs', target: 'function', arn: FUNCTION_ARN, events: ['s3:ObjectCreated:*'], prefix: 'images/', suffix: '.jpg' },
      { id: 'removals', target: 'queue', arn: QUEUE_ARN, events: ['s3:ObjectRemoved:*'], prefix: '', suffix: '' },
    ]);
    expect(entries.map(notificationText)).toEqual([
      'every new object of keys beginning with images/ and ending with .jpg: run the function thumbnails, without waiting',
      'every deletion: go to the queue removals',
    ]);
  });

  it('puts the whole list back as the API takes it, without a removed entry', () => {
    const [thumbs, removals] = entriesOf(configuration);

    expect(configurationBody([thumbs, removals])).toEqual(configuration);
    expect(configurationBody([removals])).toEqual({ lambdaFunctionConfigurations: [], queueConfigurations: configuration.queueConfigurations });
  });

  it("makes a new entry, its destination by name, which the API keeps as its ARN, its ID the API's to make", () => {
    const made = entryOf({ ...emptyNotificationForm(), destination: 'queue:uploads', events: ['s3:ObjectCreated:Put', 's3:ObjectCreated:Copy'], prefix: ' in/ ' });

    expect(made).toEqual({ entry: { id: '', target: 'queue', arn: 'uploads', events: ['s3:ObjectCreated:Put', 's3:ObjectCreated:Copy'], prefix: 'in/', suffix: '' } });
    expect(configurationBody('entry' in made ? [made.entry] : [])).toEqual({
      lambdaFunctionConfigurations: [],
      queueConfigurations: [{ queueArn: 'uploads', events: ['s3:ObjectCreated:Put', 's3:ObjectCreated:Copy'], filter: { key: { filterRules: [{ name: 'prefix', value: 'in/' }] } } }],
    });
  });

  it.each([
    [{ destination: '' }, 'Choose the function or the queue its events go to'],
    [{ destination: 'function:thumbnails', events: [] }, 'Choose at least one event'],
    [
      { destination: 'function:thumbnails', events: ['s3:ObjectCreated:*', 's3:ObjectCreated:Put'] },
      'Every new object takes uploads, copies and uploads in parts already: choose it alone, or some of them',
    ],
  ])('refuses %j, saying why', (values, problem) => {
    expect(entryOf({ ...emptyNotificationForm(), ...values })).toEqual({ problem });
  });
});
