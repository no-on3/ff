import { describe, expect, it } from 'vitest';
import type { CreatedStorageKey } from '../services/api';
import { NEW_KEY, awsVariables, draftProblem, draftReach, exportLines, keyNameProblem, keyReach, requestOf, storageChoices, tryCommand, withFunctions } from './access-keys';

describe('an access key', () => {
  const key: CreatedStorageKey = {
    id: 'AKFF7Q2MLKX4RTZB3W5N',
    name: 'AKFF7Q2MLKX4RTZB3W5N',
    buckets: ['photos'],
    queues: null,
    readOnly: true,
    functions: null,
    functionAccess: null,
    createdAt: '2026-10-23T06:36:00.000Z',
    lastUsedAt: null,
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    endpoint: 'https://s3.ffunc.cloud',
    sqsEndpoint: 'https://sqs.ffunc.cloud',
    sesEndpoint: 'https://email.ffunc.cloud',
    lambdaEndpoint: 'https://lambda.ffunc.cloud',
    region: 'tn-tunis-1',
  };
  const none = { buckets: null, queues: null, readOnly: false, functions: null, functionAccess: null };

  it('says what it reaches: every bucket and queue and the mail when it names nothing, else those it names, and its functions at their level', () => {
    expect([
      keyReach(key),
      keyReach(none),
      keyReach({ ...none, queues: ['orders'] }),
      keyReach({ ...none, buckets: ['photos'], queues: ['orders', 'invoices'], readOnly: true }),
      keyReach({ ...none, functions: ['*'], functionAccess: 'invoke', readOnly: true }),
      keyReach({ ...none, buckets: ['photos'], functions: ['orders', 'thumbnails'], functionAccess: 'write' }),
    ]).toEqual([
      'Buckets photos, read-only',
      'Every bucket and queue, and the mail',
      'Queues orders',
      'Buckets photos; queues orders, invoices, read-only',
      'Every function, to invoke',
      'Buckets photos; functions orders, thumbnails, to write',
    ]);
  });

  it("gives the seven variables AWS's SDKs and CLI read, the S3, SQS, SES and Lambda endpoints among them, as shell lines too", () => {
    expect(awsVariables(key).map(([name]) => name)).toEqual([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_REGION',
      'AWS_ENDPOINT_URL_S3',
      'AWS_ENDPOINT_URL_SQS',
      'AWS_ENDPOINT_URL_SESV2',
      'AWS_ENDPOINT_URL_LAMBDA',
    ]);
    expect(exportLines(key)).toBe(
      'export AWS_ACCESS_KEY_ID=AKFF7Q2MLKX4RTZB3W5N\nexport AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nexport AWS_REGION=tn-tunis-1\nexport AWS_ENDPOINT_URL_S3=https://s3.ffunc.cloud\nexport AWS_ENDPOINT_URL_SQS=https://sqs.ffunc.cloud\nexport AWS_ENDPOINT_URL_SESV2=https://email.ffunc.cloud\nexport AWS_ENDPOINT_URL_LAMBDA=https://lambda.ffunc.cloud',
    );
  });

  it('is tried with a command for what it reaches, none for a key to functions alone', () => {
    expect([tryCommand(key), tryCommand({ ...none, queues: ['orders'] }), tryCommand(none, 'exports'), tryCommand(none), tryCommand({ ...none, functions: ['*'] })]).toEqual([
      'aws s3 ls s3://photos',
      'aws sqs list-queues',
      'aws s3 ls s3://exports',
      'aws s3 ls s3://<bucket>',
      null,
    ]);
  });

  it("takes a name as an IAM user's, or none for its ID", () => {
    expect([keyNameProblem(''), keyNameProblem('ci+deploy@shop.tn'), keyNameProblem('a'.repeat(64))]).toEqual([null, null, null]);
    expect([keyNameProblem('my key'), keyNameProblem('a'.repeat(65)), keyNameProblem('clé')]).toEqual(Array(3).fill("1 to 64 letters, digits and +=,.@_-, as an IAM user's name"));
  });
});

describe('a new key, as the form makes it', () => {
  it('reaches every bucket and queue and the mail by default, sending nothing it would name', () => {
    expect([draftReach(NEW_KEY), draftProblem(NEW_KEY)]).toEqual(['Every bucket and queue, and the mail', null]);
    expect(requestOf(NEW_KEY)).toEqual({ readOnly: false });
  });

  it('names its buckets and queues when some are picked, and needs one', () => {
    const some = { ...NEW_KEY, storage: 'some' as const, readOnly: true };
    expect(draftProblem(some)).toBe('Pick a bucket or a queue, or choose another reach');
    const picked = { ...some, name: 'uploads', buckets: ['photos'], queues: ['orders'] };
    expect([draftReach(picked), draftProblem(picked)]).toEqual(['Buckets photos; queues orders, read-only', null]);
    expect(requestOf(picked)).toEqual({ name: 'uploads', buckets: ['photos'], queues: ['orders'], readOnly: true });
  });

  it('offers all the buckets and queues with no function, none with some: naming functions, a key names its buckets and queues too', () => {
    expect([storageChoices(NEW_KEY), storageChoices({ functions: 'all' })]).toEqual([
      ['all', 'some'],
      ['none', 'some'],
    ]);
    const all = withFunctions(NEW_KEY, 'all');
    expect([all.storage, draftReach(all)]).toEqual(['none', 'Every function, to invoke']);
    expect(requestOf({ ...all, readOnly: true })).toEqual({ readOnly: false, functions: ['*'], functionAccess: 'invoke' });
    expect(withFunctions({ ...NEW_KEY, storage: 'some', buckets: ['photos'] }, 'all').storage).toBe('some');
    expect(withFunctions(all, 'none').storage).toBe('all');
  });

  it('names the functions picked, at their level, and needs one', () => {
    const some = withFunctions(NEW_KEY, 'some');
    expect(draftProblem(some)).toBe('Pick a function, or choose all of them');
    const picked = { ...some, storage: 'some' as const, buckets: ['photos'], functionNames: ['orders'], functionAccess: 'write' as const };
    expect([draftReach(picked), draftProblem(picked)]).toEqual(['Buckets photos; functions orders, to write', null]);
    expect(requestOf(picked)).toEqual({ buckets: ['photos'], readOnly: false, functions: ['orders'], functionAccess: 'write' });
    expect(draftProblem({ ...picked, name: 'my key' })).toBe("1 to 64 letters, digits and +=,.@_-, as an IAM user's name");
  });
});
