import { ConfigService } from '@nestjs/config';
import { ApiProperty } from '@nestjs/swagger';

/** What AWS's SDKs and CLI are given, beside one of the account's keys, to reach its buckets, queues, mail and functions at FF. */
export class AwsEndpoints {
  @ApiProperty({ example: 'tn-tunis-1', description: "FF's region, AWS_REGION" }) region: string;
  @ApiProperty({ example: 'https://s3.ffunc.cloud', description: "The S3 endpoint, AWS_ENDPOINT_URL_S3, for the account's buckets" }) s3Endpoint: string;
  @ApiProperty({ example: 'https://sqs.ffunc.cloud', description: "The SQS endpoint, AWS_ENDPOINT_URL_SQS, for its queues; empty where FF has none" }) sqsEndpoint: string;
  @ApiProperty({ example: 'https://email.ffunc.cloud', description: "The SES endpoint, AWS_ENDPOINT_URL_SESV2, for its mail; empty where FF has none" }) sesEndpoint: string;
  @ApiProperty({ example: 'https://lambda.ffunc.cloud', description: "Lambda's endpoint, AWS_ENDPOINT_URL_LAMBDA, for its functions; empty where FF has none" })
  lambdaEndpoint: string;
}

/** FF's endpoints as its settings give them, S3's always, each other one empty when it isn't set. */
export function awsEndpoints(config: ConfigService): AwsEndpoints {
  return {
    region: config.getOrThrow<string>('storage.region'),
    s3Endpoint: new URL(config.getOrThrow<string>('storage.base')).origin,
    sqsEndpoint: config.get<string>('sqs.base') ?? '',
    sesEndpoint: config.get<string>('ses.base') ?? '',
    lambdaEndpoint: config.get<string>('lambda.base') ?? '',
  };
}
