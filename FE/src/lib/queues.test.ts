import { describe, expect, it } from 'vitest';
import type { Queue, QueueMetrics } from '../services/api';
import { ageText, bytesText, cliCommands, deadLetterText, durationText, endpointOf, messagesText, nameOfQueueArn, queueAttributesBody, queueForm, queueHours, queueNameProblem } from './queues';

const ARN = 'arn:aws:sqs:tn-tunis-1:000000000001';
const queue = (values: Partial<Queue> = {}): Queue => ({
  name: 'orders',
  url: 'https://sqs.ffunc.cloud/000000000001/orders',
  arn: `${ARN}:orders`,
  visibilityTimeout: 30,
  messageRetentionPeriod: 345_600,
  delaySeconds: 0,
  maximumMessageSize: 1_048_576,
  receiveMessageWaitTimeSeconds: 0,
  redrivePolicy: null,
  messages: { available: 3, inFlight: 1, delayed: 0 },
  sizeBytes: 2048,
  createdAt: '2026-10-23T08:00:00.000Z',
  updatedAt: '2026-10-23T08:00:00.000Z',
  ...values,
});

describe("a queue's name, as the API takes it", () => {
  it.each(['orders', 'orders_2-eu', 'A'])('takes %s', (name) => {
    expect(queueNameProblem(name)).toBeNull();
  });

  it.each([
    ['', 'Give the queue a name'],
    ['orders.fifo', "FF's queues are standard queues: FIFO queues come later"],
    ['with space', '1 to 80 letters, digits, hyphens or underscores, as SQS names queues'],
    ['x'.repeat(81), '1 to 80 letters, digits, hyphens or underscores, as SQS names queues'],
  ])('refuses %j, saying why', (name, problem) => {
    expect(queueNameProblem(name)).toBe(problem);
  });
});

describe('a queue, as the console says it', () => {
  it('says durations in their largest whole unit', () => {
    expect([durationText(0), durationText(1), durationText(30), durationText(60), durationText(43_200), durationText(345_600), durationText(90)]).toEqual([
      '0 seconds',
      '1 second',
      '30 seconds',
      '1 minute',
      '12 hours',
      '4 days',
      '90 seconds',
    ]);
  });

  it('says what its messages hold in bytes, KB under a megabyte, then MB', () => {
    expect([bytesText(0), bytesText(1), bytesText(46), bytesText(2048), bytesText(1536), bytesText(1_048_576), bytesText(5 * 1_048_576)]).toEqual([
      '0 bytes',
      '1 byte',
      '46 bytes',
      '2 KB',
      '1.5 KB',
      '1 MB',
      '5 MB',
    ]);
  });

  it('says its messages, those in flight and delayed when there are some', () => {
    expect([messagesText({ available: 3, inFlight: 1, delayed: 0 }), messagesText({ available: 0, inFlight: 0, delayed: 2 })]).toEqual(['3 waiting, 1 in flight', '0 waiting, 2 delayed']);
  });

  it('says where its dead letters go, and when that queue is gone', () => {
    const dlq = { arn: `${ARN}:orders-dlq` };
    expect([deadLetterText(dlq.arn, [dlq]), deadLetterText(dlq.arn, [])]).toEqual(['dead letters to orders-dlq', 'dead letters to orders-dlq, which is gone: none moves']);
  });

  it("gives the AWS CLI's commands for it, and its endpoint", () => {
    expect(cliCommands(queue())).toBe(
      "aws sqs send-message --queue-url https://sqs.ffunc.cloud/000000000001/orders --message-body '{\"hello\": \"world\"}'\naws sqs receive-message --queue-url https://sqs.ffunc.cloud/000000000001/orders --wait-time-seconds 10",
    );
    expect([endpointOf(queue()), nameOfQueueArn(`${ARN}:orders-dlq`)]).toEqual(['https://sqs.ffunc.cloud', 'orders-dlq']);
  });
});

describe("a queue's attributes, as the form changes them", () => {
  it('sends only what changed, and nothing when nothing did', () => {
    const form = queueForm(queue());
    expect(queueAttributesBody(form, queue())).toEqual({ body: {} });
    form.values.visibilityTimeout = '60';
    form.values.delaySeconds = '5';
    expect(queueAttributesBody(form, queue())).toEqual({ body: { visibilityTimeout: 60, delaySeconds: 5 } });
  });

  it("sets a dead-letter queue by its name, as its ARN under the queue's account, and removes it with null", () => {
    const form = queueForm(queue());
    form.deadLetterQueue = 'orders-dlq';
    form.maxReceiveCount = '3';
    expect(queueAttributesBody(form, queue())).toEqual({ body: { redrivePolicy: { deadLetterTargetArn: `${ARN}:orders-dlq`, maxReceiveCount: 3 } } });

    const withPolicy = queue({ redrivePolicy: { deadLetterTargetArn: `${ARN}:orders-dlq`, maxReceiveCount: 3 } });
    expect(queueForm(withPolicy)).toMatchObject({ deadLetterQueue: 'orders-dlq', maxReceiveCount: '3' });
    expect(queueAttributesBody({ ...queueForm(withPolicy), deadLetterQueue: '' }, withPolicy)).toEqual({ body: { redrivePolicy: null } });
  });

  it.each([
    ['visibilityTimeout', '43201', 'Visibility timeout: a whole number of seconds, from 0 to 43200'],
    ['messageRetentionPeriod', '59', 'Retention: a whole number of seconds, from 60 to 1209600'],
    ['delaySeconds', '1.5', 'Delivery delay: a whole number of seconds, from 0 to 900'],
    ['maximumMessageSize', '', 'Largest message: a whole number of bytes, from 1024 to 1048576'],
  ] as const)('refuses %s of %j, saying the bounds', (field, value, problem) => {
    const form = queueForm(queue());
    form.values[field] = value;
    expect(queueAttributesBody(form, queue())).toEqual({ problem });
  });

  it('refuses the queue as its own dead-letter queue, and a count out of bounds', () => {
    expect(queueAttributesBody({ ...queueForm(queue()), deadLetterQueue: 'orders' }, queue())).toEqual({ problem: "A queue can't be its own dead-letter queue" });
    expect(queueAttributesBody({ ...queueForm(queue()), deadLetterQueue: 'dlq', maxReceiveCount: '0' }, queue())).toEqual({
      problem: 'Received before it goes to the dead-letter queue: from 1 to 1,000 times',
    });
  });
});

describe("a queue's last hours, from its metrics", () => {
  const gauge = (maximum: number[]) => ({ Maximum: maximum, Average: maximum.map((value) => value / 2) });
  const metrics: QueueMetrics = {
    period: 3600,
    start: '2026-10-24T07:00:00.000Z',
    end: '2026-10-24T10:00:00.000Z',
    timestamps: ['2026-10-24T07:00:00.000Z', '2026-10-24T08:00:00.000Z', '2026-10-24T09:00:00.000Z'],
    metrics: {
      ApproximateNumberOfMessagesVisible: gauge([2, 0, 0]),
      ApproximateNumberOfMessagesNotVisible: gauge([1, 0, 0]),
      ApproximateNumberOfMessagesDelayed: gauge([0, 0, 0]),
      ApproximateAgeOfOldestMessage: { Maximum: [240, 0, 0] },
      NumberOfMessagesSent: { Sum: [3, 0, 0] },
      NumberOfMessagesReceived: { Sum: [1, 0, 2] },
      NumberOfMessagesDeleted: { Sum: [0, 0, 2] },
      NumberOfEmptyReceives: { Sum: [0, 0, 0] },
      SentMessageSize: { Average: [12, null, null], Maximum: [20, null, null] },
    },
  };

  it('gives each hour it held a message in or was asked something, newest first, a quiet hour left out', () => {
    expect(queueHours(metrics)).toEqual([
      { at: '2026-10-24T09:00:00.000Z', waiting: 0, inFlight: 0, oldestSeconds: 0, sent: 0, received: 2, deleted: 2 },
      { at: '2026-10-24T07:00:00.000Z', waiting: 2, inFlight: 1, oldestSeconds: 240, sent: 3, received: 1, deleted: 0 },
    ]);
    expect(queueHours(metrics, 1)).toHaveLength(1);
  });

  it('says an age in seconds, minutes, hours or days, as it is long', () => {
    expect([ageText(1), ageText(90), ageText(240), ageText(7_200), ageText(200_000)]).toEqual(['1 second', '90 seconds', '4 minutes', '2 hours', '2 days']);
  });
});
