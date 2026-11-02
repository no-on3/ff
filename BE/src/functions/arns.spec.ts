/**
 * L1: functions' ARNs, as AWS Lambda's: made from a function's name, qualified
 * by a version or an alias, and read back, $LATEST as none; and a function's
 * name, qualified as Lambda's FunctionName takes it.
 */
import { QUALIFIED_NAME, functionArn, parseFunctionArn, parseFunctionName, qualifiedFunctionArn } from './arns';

const BASE = 'arn:aws:lambda:tn-tunis-1:000000000001:function:orders';

describe("functions' ARNs (L1)", () => {
  it('makes a function\'s ARN, qualified or not', () => {
    expect([functionArn('tn-tunis-1', '000000000001', 'orders'), qualifiedFunctionArn('tn-tunis-1', '000000000001', 'orders', 'live')]).toEqual([BASE, `${BASE}:live`]);
    expect(qualifiedFunctionArn('tn-tunis-1', '000000000001', 'orders')).toBe(BASE);
  });

  it('reads the function, and the version or the alias that qualifies it; $LATEST and none name the function as it is', () => {
    const orders = { region: 'tn-tunis-1', accountId: '000000000001', name: 'orders' };

    expect([parseFunctionArn(BASE), parseFunctionArn(`${BASE}:$LATEST`)]).toEqual([orders, orders]);
    expect([parseFunctionArn(`${BASE}:3`), parseFunctionArn(`${BASE}:live`)]).toEqual([
      { ...orders, qualifier: '3' },
      { ...orders, qualifier: 'live' },
    ]);
  });

  it("refuses what Lambda's ARN can't be: version 0, another service, a qualifier past its length, a part more", () => {
    for (const arn of [`${BASE}:0`, `${BASE}:01`, 'arn:aws:sqs:tn-tunis-1:000000000001:orders', `${BASE}:${'a'.repeat(129)}`, `${BASE}:live:2`, `${BASE}:`]) {
      expect(parseFunctionArn(arn)).toBeUndefined();
    }
  });

  it("takes a function's name alone, or with a version or an alias after a colon, as Lambda's FunctionName does", () => {
    expect(['orders', 'orders:live', 'orders:3', 'orders:$LATEST'].map((name) => QUALIFIED_NAME.test(name))).toEqual([true, true, true, true]);
    expect(['orders:', 'orders:0', 'orders:live:2', 'or ders', 'a'.repeat(65), `orders:${'a'.repeat(129)}`].map((name) => QUALIFIED_NAME.test(name))).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("reads a FunctionName in each of Lambda's forms: a name, its ARN, its partial ARN, each qualified or not", () => {
    expect(['orders', 'orders:$LATEST', '000000000001:function:orders', BASE].map(parseFunctionName)).toEqual([
      { name: 'orders' },
      { name: 'orders' },
      { name: 'orders', accountId: '000000000001' },
      { name: 'orders', accountId: '000000000001', region: 'tn-tunis-1' },
    ]);
    expect(['orders:live', '000000000002:function:orders:3', `${BASE}:live`].map(parseFunctionName)).toEqual([
      { name: 'orders', qualifier: 'live' },
      { name: 'orders', accountId: '000000000002', qualifier: '3' },
      { name: 'orders', accountId: '000000000001', region: 'tn-tunis-1', qualifier: 'live' },
    ]);
    for (const value of ['', 'or ders', 'orders:0', 'orders:live:2', '1:function:orders', 'arn:aws:sqs:tn-tunis-1:000000000001:orders', `${BASE}:`]) {
      expect(parseFunctionName(value)).toBeUndefined();
    }
  });
});
