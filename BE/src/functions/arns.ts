/** A function's ARN, as AWS Lambda's: arn:aws:lambda:<region>:<account>:function:<name>. FF names its functions in theirs. */
export const functionArn = (region: string, accountId: string, name: string): string => `arn:aws:lambda:${region}:${accountId}:function:${name}`;

const FUNCTION_ARN = /^arn:aws:lambda:([a-z]{2}(?:-[a-z]+)+-\d+):(\d{12}):function:([A-Za-z0-9_-]{1,64})(?::\$LATEST)?$/;

/** What a Lambda function's ARN names, its version $LATEST or none; undefined for any other string. */
export function parseFunctionArn(arn: string): { region: string; accountId: string; name: string } | undefined {
  const match = FUNCTION_ARN.exec(arn);
  return match ? { region: match[1], accountId: match[2], name: match[3] } : undefined;
}
