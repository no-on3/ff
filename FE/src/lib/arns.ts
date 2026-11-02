/**
 * AWS's ARNs, as the console reads them: a Lambda function's, qualified or
 * not, and any other's name, a queue's.
 */

/** The function a Lambda ARN names, arn:aws:lambda:<region>:<account>:function:<name>[:<qualifier>], with the version or the alias that qualifies it, none for $LATEST; undefined for any other ARN. */
export function functionOfArn(arn: string): { name: string; qualifier?: string } | undefined {
  const match = /:function:([^:]+)(?::([^:]+))?$/.exec(arn);
  if (!match) return undefined;
  return match[2] && match[2] !== '$LATEST' ? { name: match[1], qualifier: match[2] } : { name: match[1] };
}

/** What a person reads of an ARN: a function's name, its version or alias after a colon as Lambda writes a qualified name (thumbnails:live); any other ARN's last part, a queue's name. */
export function nameOfArn(arn: string): string {
  const named = functionOfArn(arn);
  if (!named) return arn.slice(arn.lastIndexOf(':') + 1);
  return named.qualifier ? `${named.name}:${named.qualifier}` : named.name;
}
