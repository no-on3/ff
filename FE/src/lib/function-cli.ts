import { type AwsEndpoints, type Function } from '../services/api';
import { endpointVariables, shellExports } from './access-keys';

/** What the AWS CLI needs, beside one of the account's access keys, to reach FF's Lambda: the region and Lambda's endpoint. */
export const lambdaExports = (aws: AwsEndpoints): string =>
  shellExports(endpointVariables(aws).filter(([name]) => name === 'AWS_REGION' || name === 'AWS_ENDPOINT_URL_LAMBDA'));

/** The AWS CLI's commands for a function at FF's Lambda endpoint, by its name: read it, call it with its log, give it new code, publish a version. */
export function lambdaCommands(func: Pick<Function, 'name'>): string {
  const { name } = func;
  return [
    `aws lambda get-function --function-name ${name}`,
    `aws lambda invoke --function-name ${name} --cli-binary-format raw-in-base64-out --payload '{}' --log-type Tail --query LogResult --output text out.json | base64 -d`,
    `aws lambda update-function-code --function-name ${name} --zip-file fileb://function.zip`,
    `aws lambda publish-version --function-name ${name}`,
  ].join('\n');
}
