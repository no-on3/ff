/**
 * L1: FF's region and endpoints, as GET /me and a new key's answer give them
 * to AWS's SDKs and CLI, read from the settings in one place.
 */
import { ConfigService } from '@nestjs/config';
import { awsEndpoints } from './aws-endpoints';

const settingsOf = (values: Record<string, string>) =>
  ({
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (values[key] === undefined) throw new TypeError(`Configuration key "${key}" does not exist`);
      return values[key];
    },
  }) as unknown as ConfigService;

describe("FF's endpoints for AWS's tools (L1)", () => {
  it("gives the region, S3's origin without the bucket's path, and SQS's, SES's and Lambda's as set", () => {
    const config = settingsOf({
      'storage.region': 'tn-tunis-1',
      'storage.base': 'https://s3.ffunc.cloud/',
      'sqs.base': 'https://sqs.ffunc.cloud',
      'ses.base': 'https://email.ffunc.cloud',
      'lambda.base': 'https://lambda.ffunc.cloud',
    });

    expect(awsEndpoints(config)).toEqual({
      region: 'tn-tunis-1',
      s3Endpoint: 'https://s3.ffunc.cloud',
      sqsEndpoint: 'https://sqs.ffunc.cloud',
      sesEndpoint: 'https://email.ffunc.cloud',
      lambdaEndpoint: 'https://lambda.ffunc.cloud',
    });
  });

  it('gives an endpoint FF has no setting for as empty, and needs the region and S3', () => {
    const config = settingsOf({ 'storage.region': 'tn-tunis-1', 'storage.base': 'http://localhost:3002' });

    expect(awsEndpoints(config)).toEqual({ region: 'tn-tunis-1', s3Endpoint: 'http://localhost:3002', sqsEndpoint: '', sesEndpoint: '', lambdaEndpoint: '' });
    expect(() => awsEndpoints(settingsOf({ 'storage.base': 'http://localhost:3002' }))).toThrow('storage.region');
  });
});
