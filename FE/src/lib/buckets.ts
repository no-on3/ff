import type { Bucket, BucketMetrics, CreatedStorageKey, MeAccount, StorageKey } from '../services/api';

/** A bucket's name, as the API takes it: AWS's rule without dots. contract.test.ts checks it against the API's. */
export const BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** AWS's prefixes and suffixes, which no bucket of AWS's may have, and so no bucket of FF's. */
const RESERVED = [/^xn--/, /^sthree-/, /^amzn-s3-demo-/, /-s3alias$/, /--ol-s3$/, /--x-s3$/, /--table-s3$/];

/** Why the API would refuse the name, said before sending it; null when it would take it. */
export function bucketNameProblem(name: string): string | null {
  if (name === '') return 'Give the bucket a name';
  if (!BUCKET_NAME.test(name)) return '3 to 63 lower-case letters, digits and hyphens, a letter or a digit first and last, as AWS names buckets, without dots';
  if (RESERVED.some((pattern) => pattern.test(name))) return 'AWS keeps names like this one for itself: a bucket on FF must be able to move to S3';
  return null;
}

/** What a key reaches, in words: every bucket and queue of the account when it names neither, else those it names. */
export function keyReach(key: Pick<StorageKey, 'buckets' | 'queues' | 'readOnly'>): string {
  const named = [key.buckets && `buckets ${key.buckets.join(', ')}`, key.queues && `queues ${key.queues.join(', ')}`].filter(Boolean).join('; ');
  const reach = named ? named.charAt(0).toUpperCase() + named.slice(1) : 'Every bucket and queue';
  return key.readOnly ? `${reach}, read-only` : reach;
}

/** The variables AWS's SDKs and CLI read, for a key just made: to export in a shell, or set as a function's secrets. */
export function awsVariables(key: CreatedStorageKey): Array<[name: string, value: string]> {
  return [
    ['AWS_ACCESS_KEY_ID', key.id],
    ['AWS_SECRET_ACCESS_KEY', key.secretAccessKey],
    ['AWS_REGION', key.region],
    ['AWS_ENDPOINT_URL_S3', key.endpoint],
    ['AWS_ENDPOINT_URL_SQS', key.sqsEndpoint],
    ['AWS_ENDPOINT_URL_SESV2', key.sesEndpoint],
  ];
}

/** Those variables as shell lines. */
export const exportLines = (key: CreatedStorageKey): string =>
  awsVariables(key)
    .map(([name, value]) => `export ${name}=${value}`)
    .join('\n');

/** What the buckets page says when the account's buckets near or reach the plan's storage, all of them together; null under 80%. */
export function storageNotice(account: Pick<MeAccount, 'bucketStorageNotice' | 'plan'>): { tone: 'warning' | 'danger'; title: string; text: string } | null {
  const limit = `${account.plan.limits.bucketStorageMb.toLocaleString('en-US')} MB`;
  if (account.bucketStorageNotice === 100) {
    return {
      tone: 'danger',
      title: 'Your buckets are full: uploads wait for room',
      text: `They hold all of the ${limit} your plan gives them together. Uploads are refused (AccountProblem) until they hold less; reading and deleting files go on, and once you delete some, uploads go in again within a minute.`,
    };
  }
  if (account.bucketStorageNotice === 80) {
    return {
      tone: 'warning',
      title: "Your buckets hold 80% or more of your plan's storage",
      text: `At ${limit} together, uploads wait for room until they hold less. Delete what you no longer need, or move to a plan with more storage.`,
    };
  }
  return null;
}

/** A bucket's two addresses: its own, virtual-hosted, and the endpoint's, path-style, as boto3 and the CLI address it. */
export const addresses = (bucket: Pick<Bucket, 'name' | 'endpoint' | 'url'>): { virtualHosted: string; pathStyle: string } => ({
  virtualHosted: bucket.url,
  pathStyle: `${bucket.endpoint}/${bucket.name}`,
});

/** The AWS CLI, its endpoint given, listing the bucket. */
export const listCommand = (bucket: Pick<Bucket, 'name' | 'endpoint'>): string => `aws --endpoint-url ${bucket.endpoint} s3 ls s3://${bucket.name}`;

/** One hour of a bucket, as its page lists it: what it held then, and its requests. */
export interface BucketHour {
  at: string;
  sizeBytes: number;
  objects: number;
  requests: number;
  errors: number;
}

/** The hours measured in a bucket's metrics, a point an hour, newest first: what it held, its requests and those that failed. */
export function measuredHours(metrics: BucketMetrics, count = 24): BucketHour[] {
  const m = metrics.metrics;
  const hours: BucketHour[] = [];
  for (let index = metrics.timestamps.length - 1; index >= 0 && hours.length < count; index--) {
    const sizeBytes = m.BucketSizeBytes.Average[index];
    const objects = m.NumberOfObjects.Average[index];
    if (sizeBytes === null || objects === null) continue;
    hours.push({ at: metrics.timestamps[index], sizeBytes, objects, requests: m.AllRequests.Sum[index], errors: m['4xxErrors'].Sum[index] + m['5xxErrors'].Sum[index] });
  }
  return hours;
}

/** A count of requests or bytes summed over the metrics' periods. */
export const total = (series: number[]): number => series.reduce((sum, value) => sum + value, 0);
