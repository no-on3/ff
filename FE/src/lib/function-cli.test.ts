import { describe, expect, it } from 'vitest';
import { AWS_ENDPOINTS } from '../test-fixtures';
import { lambdaCommands, lambdaExports } from './function-cli';

describe("a function's AWS CLI commands", () => {
  it("say where FF's Lambda is, the region and the endpoint alone, beside one of the account's keys", () => {
    expect(lambdaExports(AWS_ENDPOINTS)).toBe('export AWS_REGION=tn-tunis-1\nexport AWS_ENDPOINT_URL_LAMBDA=https://lambda.ffunc.cloud');
  });

  it('read it, call it with its log, give it new code and publish a version, by its name', () => {
    expect(lambdaCommands({ name: 'orders' }).split('\n')).toEqual([
      'aws lambda get-function --function-name orders',
      "aws lambda invoke --function-name orders --cli-binary-format raw-in-base64-out --payload '{}' --log-type Tail --query LogResult --output text out.json | base64 -d",
      'aws lambda update-function-code --function-name orders --zip-file fileb://function.zip',
      'aws lambda publish-version --function-name orders',
    ]);
  });
});
