import { describe, expect, it } from 'vitest';
import { functionOfArn, nameOfArn } from './arns';

const FUNCTION = 'arn:aws:lambda:tn-tunis-1:000000000001:function:thumbnails';

describe("AWS's ARNs, as the console reads them", () => {
  it("reads a function's name, and the version or the alias that qualifies it, none for $LATEST", () => {
    expect([functionOfArn(FUNCTION), functionOfArn(`${FUNCTION}:live`), functionOfArn(`${FUNCTION}:3`), functionOfArn(`${FUNCTION}:$LATEST`)]).toEqual([
      { name: 'thumbnails' },
      { name: 'thumbnails', qualifier: 'live' },
      { name: 'thumbnails', qualifier: '3' },
      { name: 'thumbnails' },
    ]);
    expect(functionOfArn('arn:aws:sqs:tn-tunis-1:000000000001:uploads')).toBeUndefined();
  });

  it("names a function as Lambda writes a qualified name, and any other ARN by its last part", () => {
    expect([nameOfArn(FUNCTION), nameOfArn(`${FUNCTION}:live`), nameOfArn(`${FUNCTION}:$LATEST`), nameOfArn('arn:aws:sqs:tn-tunis-1:000000000001:uploads')]).toEqual([
      'thumbnails',
      'thumbnails:live',
      'thumbnails',
      'uploads',
    ]);
  });
});
