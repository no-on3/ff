/**
 * L1: Lambda's reserved concurrency over FF's instances: PutFunctionConcurrency
 * onto the function's maxInstances, 0 stopping every call, within the plan and
 * no fewer than the instances it keeps running; GetFunctionConcurrency, none at
 * FF's default; DeleteFunctionConcurrency, FF's default again; each naming the
 * function alone, refused in Lambda's words.
 */
import { Function } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { LambdaConcurrency, reservedConcurrency } from './lambda-concurrency';
import { ACCOUNT, lambdaCall, lambdaCaller, refused } from './test-fixtures';

const PUT = '/2017-10-31/functions/orders/concurrency';
const GET = '/2019-09-30/functions/orders/concurrency';

describe("Lambda's reserved concurrency (L1)", () => {
  let function_: Function;
  let reserveConcurrency: jest.Mock;
  let handlers: LambdaConcurrency;

  beforeEach(() => {
    function_ = Object.assign(new Function(), { id: 'f-orders', accountId: ACCOUNT, name: 'orders', minInstances: 0, maxInstances: 3, callsStopped: false });
    reserveConcurrency = jest.fn(async (_account: string, _id: string, reserved: Partial<Function>) => Object.assign(function_, reserved));
    handlers = new LambdaConcurrency({ reserveConcurrency } as unknown as FunctionsService);
  });

  /** A request as the front door hands it on: the function its path names found, a qualifier from its name. */
  async function ask(method: string, target: string, input: Record<string, unknown> = {}, qualifier?: string) {
    const call = lambdaCall(method, target, input);
    const answer = await handlers.handlers[call.operation.name](call, lambdaCaller({ function_, named: { name: 'orders', ...(qualifier ? { qualifier } : {}) } }));
    return { status: answer.status, document: answer.document as Record<string, unknown> | undefined };
  }
  const put = (reserved: unknown) => ask('PUT', PUT, { ReservedConcurrentExecutions: reserved });

  it("reads FF's default as no reservation, so that a tool's default sees nothing to change; else the most instances, 0 while its calls are stopped", async () => {
    expect(await ask('GET', GET)).toEqual({ status: 200, document: {} });
    expect([
      reservedConcurrency({ maxInstances: 3, callsStopped: false }),
      reservedConcurrency({ maxInstances: 5, callsStopped: false }),
      reservedConcurrency({ maxInstances: 5, callsStopped: true }),
    ]).toEqual([undefined, 5, 0]);
  });

  it("PutFunctionConcurrency sets the function's most instances, answering Lambda's reservation, which Get reads back", async () => {
    expect(await put(5)).toEqual({ status: 200, document: { ReservedConcurrentExecutions: 5 } });

    expect(reserveConcurrency).toHaveBeenCalledWith(ACCOUNT, 'f-orders', { maxInstances: 5, callsStopped: false });
    expect((await ask('GET', GET)).document).toEqual({ ReservedConcurrentExecutions: 5 });
  });

  it('stops every call with 0, its most instances kept for when calls start again; more, or none, starts them', async () => {
    function_.maxInstances = 5;
    expect((await put(0)).document).toEqual({ ReservedConcurrentExecutions: 0 });
    expect(reserveConcurrency).toHaveBeenLastCalledWith(ACCOUNT, 'f-orders', { maxInstances: 5, callsStopped: true });
    expect((await ask('GET', GET)).document).toEqual({ ReservedConcurrentExecutions: 0 });

    await put(2);
    expect(function_.callsStopped).toBe(false);
    await put(0);
    expect(await ask('DELETE', PUT)).toEqual({ status: 204, document: undefined });
    expect(reserveConcurrency).toHaveBeenLastCalledWith(ACCOUNT, 'f-orders', { maxInstances: 3, callsStopped: false });
    expect((await ask('GET', GET)).document).toEqual({});
  });

  it('DeleteFunctionConcurrency keeps no fewer instances than those the function keeps running', async () => {
    function_.minInstances = 4;
    await ask('DELETE', PUT);
    expect(reserveConcurrency).toHaveBeenLastCalledWith(ACCOUNT, 'f-orders', { maxInstances: 4, callsStopped: false });
  });

  it("refuses past the plan's instances, fewer than the function keeps running, a number that isn't whole, another field, a version or an alias", async () => {
    expect(await refused(put(11))).toEqual([
      400,
      'InvalidParameterValueException',
      "ReservedConcurrentExecutions must be at most 10 on the Beta plan: each of a function's instances serves one call at a time.",
    ]);
    function_.minInstances = 2;
    for (const reserved of [1, 0]) {
      expect(await refused(put(reserved))).toEqual([
        400,
        'InvalidParameterValueException',
        "ReservedConcurrentExecutions must be at least 2, the instances the function keeps running, as Lambda's provisioned concurrency must fit within it.",
      ]);
    }
    for (const reserved of [-1, 1.5, '3', undefined]) {
      const [, type, message] = await refused(put(reserved));
      expect([type, message]).toEqual(['InvalidParameterValueException', expect.stringMatching(/^ReservedConcurrentExecutions must be a whole number of calls at once, 0 or more, not /)]);
    }
    expect(await refused(ask('PUT', PUT, { ReservedConcurrentExecutions: 2, Qualifier: '1' }))).toEqual([400, 'InvalidParameterValueException', "FF doesn't take Qualifier in PutFunctionConcurrency."]);
    for (const [method, target] of [['PUT', PUT], ['GET', GET], ['DELETE', PUT]]) {
      const [status, type, message] = await refused(ask(method, target, { ReservedConcurrentExecutions: 2 }, 'live'));
      expect([status, type, message]).toEqual([400, 'InvalidParameterValueException', expect.stringMatching(/names the function alone, not its version or alias live: send orders\.$/)]);
    }
    expect(reserveConcurrency).not.toHaveBeenCalled();
  });
});
