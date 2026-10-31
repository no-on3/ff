import { describe, expect, it } from 'vitest';
import type { BucketMetrics, CreatedStorageKey } from '../services/api';
import { BETA_PLAN } from '../test-fixtures';
import { addresses, awsVariables, bucketNameProblem, exportLines, keyReach, listCommand, measuredHours, storageNotice, total } from './buckets';

describe("a bucket's name, as the API takes it", () => {
  it.each(['photos', 'abc', 'my-app-2026', '123'])('takes %s', (name) => {
    expect(bucketNameProblem(name)).toBeNull();
  });

  it.each(['ab', 'Photos', 'my.photos', '-photos', 'photos-', 'my_photos', `a${'b'.repeat(62)}c`])('refuses %j, saying what a name is', (name) => {
    expect(bucketNameProblem(name)).toBe('3 to 63 lower-case letters, digits and hyphens, a letter or a digit first and last, as AWS names buckets, without dots');
  });

  it('refuses what AWS keeps for itself, and asks for a name when there is none', () => {
    expect([bucketNameProblem('xn--photos'), bucketNameProblem('photos-s3alias'), bucketNameProblem('')]).toEqual([
      'AWS keeps names like this one for itself: a bucket on FF must be able to move to S3',
      'AWS keeps names like this one for itself: a bucket on FF must be able to move to S3',
      'Give the bucket a name',
    ]);
  });
});

describe('an access key', () => {
  const key: CreatedStorageKey = {
    id: 'AKFF7Q2MLKX4RTZB3W5N',
    buckets: ['photos'],
    queues: null,
    readOnly: true,
    createdAt: '2026-10-23T06:36:00.000Z',
    lastUsedAt: null,
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    endpoint: 'https://s3.ffunc.cloud',
    sqsEndpoint: 'https://sqs.ffunc.cloud',
    sesEndpoint: 'https://email.ffunc.cloud',
    region: 'tn-tunis-1',
  };

  it('says what it reaches: every bucket and queue when it names neither, else those it names', () => {
    expect([
      keyReach(key),
      keyReach({ buckets: null, queues: null, readOnly: false }),
      keyReach({ buckets: null, queues: ['orders'], readOnly: false }),
      keyReach({ buckets: ['photos'], queues: ['orders', 'invoices'], readOnly: true }),
    ]).toEqual(['Buckets photos, read-only', 'Every bucket and queue', 'Queues orders', 'Buckets photos; queues orders, invoices, read-only']);
  });

  it("gives the six variables AWS's SDKs and CLI read, the S3, SQS and SES endpoints among them, as shell lines too", () => {
    expect(awsVariables(key).map(([name]) => name)).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_ENDPOINT_URL_S3', 'AWS_ENDPOINT_URL_SQS', 'AWS_ENDPOINT_URL_SESV2']);
    expect(exportLines(key)).toBe(
      'export AWS_ACCESS_KEY_ID=AKFF7Q2MLKX4RTZB3W5N\nexport AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nexport AWS_REGION=tn-tunis-1\nexport AWS_ENDPOINT_URL_S3=https://s3.ffunc.cloud\nexport AWS_ENDPOINT_URL_SQS=https://sqs.ffunc.cloud\nexport AWS_ENDPOINT_URL_SESV2=https://email.ffunc.cloud',
    );
  });
});

describe("the account's buckets against its plan's storage", () => {
  it('says nothing under 80%, warns at 80%, and at 100% says uploads wait while reading and deleting go on', () => {
    expect(storageNotice({ bucketStorageNotice: null, plan: BETA_PLAN })).toBeNull();
    expect(storageNotice({ bucketStorageNotice: 80, plan: BETA_PLAN })).toEqual({
      tone: 'warning',
      title: "Your buckets hold 80% or more of your plan's storage",
      text: 'At 5,120 MB together, uploads wait for room until they hold less. Delete what you no longer need, or move to a plan with more storage.',
    });
    const full = storageNotice({ bucketStorageNotice: 100, plan: BETA_PLAN });
    expect([full?.tone, full?.title]).toEqual(['danger', 'Your buckets are full: uploads wait for room']);
    expect(full?.text).toContain('Uploads are refused (AccountProblem) until they hold less; reading and deleting files go on');
  });
});

describe("a bucket's page", () => {
  const bucket = { name: 'photos', endpoint: 'https://s3.ffunc.cloud', url: 'https://photos.s3.ffunc.cloud' };

  it('gives its two addresses, and the CLI listing it', () => {
    expect(addresses(bucket)).toEqual({ virtualHosted: 'https://photos.s3.ffunc.cloud', pathStyle: 'https://s3.ffunc.cloud/photos' });
    expect(listCommand(bucket)).toBe('aws --endpoint-url https://s3.ffunc.cloud s3 ls s3://photos');
  });

  it('lists the hours measured, newest first, with what it held, its requests and those that failed; an hour unmeasured left out', () => {
    const sums = (values: number[]) => ({ Sum: values });
    const metrics: BucketMetrics = {
      period: 3600,
      start: '2026-10-23T08:00:00.000Z',
      end: '2026-10-23T11:00:00.000Z',
      timestamps: ['2026-10-23T08:00:00.000Z', '2026-10-23T09:00:00.000Z', '2026-10-23T10:00:00.000Z'],
      metrics: {
        BucketSizeBytes: { Average: [1_000, null, 161_480_253] },
        NumberOfObjects: { Average: [1, null, 1_204] },
        AllRequests: sums([3, 9, 50]),
        GetRequests: sums([0, 9, 40]),
        PutRequests: sums([3, 0, 10]),
        '4xxErrors': sums([0, 2, 1]),
        '5xxErrors': sums([0, 0, 2]),
        BytesDownloaded: sums([0, 9_000, 4_000]),
        BytesUploaded: sums([3_000, 0, 1_000]),
      },
    };

    expect(measuredHours(metrics)).toEqual([
      { at: '2026-10-23T10:00:00.000Z', sizeBytes: 161_480_253, objects: 1_204, requests: 50, errors: 3 },
      { at: '2026-10-23T08:00:00.000Z', sizeBytes: 1_000, objects: 1, requests: 3, errors: 0 },
    ]);
    expect(measuredHours(metrics, 1)).toHaveLength(1);
    expect(total(metrics.metrics.AllRequests.Sum)).toBe(62);
  });
});
