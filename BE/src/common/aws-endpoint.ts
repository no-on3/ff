/**
 * An AWS service FF serves at an endpoint of its own, which AWS's SDKs reach
 * with an access key of the account's: the S3 front door, the SQS endpoint and
 * the SES endpoint. Named as AWS's configuration names a service's endpoint, its
 * variable being AWS_ENDPOINT_URL_S3, _SQS or _SESV2. A function is given their
 * addresses, with its key (its awsEndpoints, FunctionKeys); the front doors note
 * what each key uses of them (KeyUses).
 */
export enum AwsEndpoint {
  S3 = 's3',
  SQS = 'sqs',
  SESV2 = 'sesv2',
}

/** Every service FF gives a function the endpoint of, in this order: what a function has unless its owner says otherwise. */
export const AWS_ENDPOINTS: readonly AwsEndpoint[] = Object.values(AwsEndpoint);

/** The services named, in AWS_ENDPOINTS' order, as a function keeps them; every one when none are named. */
export function awsEndpointsOf(named?: readonly AwsEndpoint[]): AwsEndpoint[] {
  return AWS_ENDPOINTS.filter((service) => named === undefined || named.includes(service));
}
