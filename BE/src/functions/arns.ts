import { FUNCTION_NAME } from './dto/create-function.dto';
import { QUALIFIER } from './qualifier';

/** A pattern's text without its anchors, to build another with. */
const unanchored = (pattern: RegExp): string => pattern.source.slice(1, -1);

/** A function's ARN, as AWS Lambda's: arn:aws:lambda:<region>:<account>:function:<name>. FF names its functions in theirs. */
export const functionArn = (region: string, accountId: string, name: string): string => `arn:aws:lambda:${region}:${accountId}:function:${name}`;

/** A function's ARN qualified, as Lambda's: by a version's number or an alias's name; unqualified for none. */
export const qualifiedFunctionArn = (region: string, accountId: string, name: string, qualifier?: string): string =>
  functionArn(region, accountId, name) + (qualifier === undefined ? '' : `:${qualifier}`);

/** A function's ARN, qualified or not: its qualifier is a call's, the fourth group. */
const FUNCTION_ARN = new RegExp(`^arn:aws:lambda:([a-z]{2}(?:-[a-z]+)+-\\d+):(\\d{12}):function:(${unanchored(FUNCTION_NAME)})(?::${unanchored(QUALIFIER)})?$`);

/** A function's name, then the version or the alias that qualifies it after a colon, or none: Lambda's FunctionName without its ARN (thumbnails:live). */
export const QUALIFIED_NAME = new RegExp(`^${unanchored(FUNCTION_NAME)}(?::${unanchored(QUALIFIER)})?$`);

/** A function's name, or its partial ARN (<account>:function:<name>), each qualified or not: the account, the name, the qualifier. */
const SHORT_NAME = new RegExp(`^(?:(\\d{12}):function:)?(${unanchored(FUNCTION_NAME)})(?::${unanchored(QUALIFIER)})?$`);

/** What a FunctionName names: the function's name, the version or the alias after it, and the account and the region it says, if it does. */
export interface FunctionNamed {
  name: string;
  qualifier?: string;
  accountId?: string;
  region?: string;
}

/**
 * What a FunctionName names, as Lambda takes one: a function's name
 * (orders), with a version or an alias after a colon (orders:live), its ARN,
 * or its partial ARN (000000000001:function:orders), each qualified or not;
 * $LATEST and none name the function as it is; undefined for any other string.
 */
export function parseFunctionName(value: string): FunctionNamed | undefined {
  if (value.startsWith('arn:')) return parseFunctionArn(value);
  const match = SHORT_NAME.exec(value);
  if (!match) return undefined;
  return { name: match[2], ...(match[1] ? { accountId: match[1] } : {}), ...(match[3] && match[3] !== '$LATEST' ? { qualifier: match[3] } : {}) };
}

/**
 * What a Lambda function's ARN names: its function, and the version or the alias that qualifies it, none for
 * $LATEST, as Lambda takes either; undefined for any other string.
 */
export function parseFunctionArn(arn: string): { region: string; accountId: string; name: string; qualifier?: string } | undefined {
  const match = FUNCTION_ARN.exec(arn);
  if (!match) return undefined;
  return { region: match[1], accountId: match[2], name: match[3], ...(match[4] && match[4] !== '$LATEST' ? { qualifier: match[4] } : {}) };
}
