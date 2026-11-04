/** L1: Lambda's tags on a function (TagResource, UntagResource, ListTags), over FF's tags service. */
import { Function } from '../functions/entities/function.entity';
import { ResourceTagsService, Tagged, taggedFunction } from '../tags/resource-tags.service';
import { LambdaTags } from './lambda-tags';
import { ACCOUNT, REGION, lambdaCall, lambdaCaller, refused } from './test-fixtures';

const ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:orders`;

describe("Lambda's tags on a function (L1)", () => {
  let tagged: Record<string, Record<string, string>>;
  let lambdaTags: LambdaTags;
  const service = {
    of: jest.fn(async ({ id }: Tagged) => tagged[id] ?? {}),
    tag: jest.fn(async (_account: string, { id }: Tagged, tags: Record<string, string>) => void (tagged[id] = { ...tagged[id], ...tags })),
    untag: jest.fn(async (_account: string, { id }: Tagged, keys: string[]) => {
      for (const key of keys) delete tagged[id]?.[key];
    }),
  };

  beforeEach(() => {
    tagged = { 'f-orders': { team: 'shop' } };
    jest.clearAllMocks();
    lambdaTags = new LambdaTags(service as unknown as ResourceTagsService);
  });

  /** A request as the front door hands it on: its operation, the function its ARN names, found in the account. */
  function ask(method: string, target: string, input: Record<string, unknown> = {}, qualifier?: string) {
    const call = lambdaCall(method, target, input);
    const function_ = Object.assign(new Function(), { id: 'f-orders', accountId: ACCOUNT, name: 'orders' });
    return lambdaTags.handlers[call.operation.name](call, lambdaCaller({ function_, named: { name: 'orders', ...(qualifier ? { qualifier } : {}) } }));
  }

  const path = `/2017-03-31/tags/${encodeURIComponent(ARN)}`;

  it('TagResource puts the tags on the function, answering 204 as Lambda does; ListTags gives them by key', async () => {
    expect(await ask('POST', path, { Tags: { stage: 'prod', team: 'orders' } })).toEqual({ status: 204 });
    expect(service.tag).toHaveBeenCalledWith(ACCOUNT, taggedFunction('f-orders'), { stage: 'prod', team: 'orders' });
    expect(await ask('GET', path)).toEqual({ status: 200, document: { Tags: { team: 'orders', stage: 'prod' } } });
  });

  it('UntagResource removes the tags of each key in tagKeys', async () => {
    tagged['f-orders'] = { team: 'shop', stage: 'prod', owner: 'ops' };

    expect(await ask('DELETE', `${path}?tagKeys=stage&tagKeys=owner`)).toEqual({ status: 204 });
    expect(service.untag).toHaveBeenCalledWith(ACCOUNT, taggedFunction('f-orders'), ['stage', 'owner']);
    expect(await ask('GET', path)).toEqual({ status: 200, document: { Tags: { team: 'shop' } } });
  });

  it("refuses tags that aren't an object of strings, none at all, no key to remove, and a version's or an alias's ARN", async () => {
    expect(await refused(ask('POST', path, {}))).toEqual([400, 'InvalidParameterValueException', 'Tags is required: the tags to put on the function, each value by its key.']);
    for (const Tags of [['team'], 'team=shop', { team: 7 }, null]) {
      expect(await refused(ask('POST', path, { Tags }))).toEqual([400, 'InvalidParameterValueException', "Tags must be an object of strings, each tag's value by its key."]);
    }
    expect(await refused(ask('DELETE', path))).toEqual([400, 'InvalidParameterValueException', 'tagKeys is required: the keys of the tags to remove.']);
    expect(await refused(ask('GET', `/2017-03-31/tags/${encodeURIComponent(`${ARN}:live`)}`, {}, 'live'))).toEqual([
      400,
      'InvalidParameterValueException',
      "Tags are a function's, not its version's or its alias's: name the function's ARN, without :live.",
    ]);
    expect(service.tag).not.toHaveBeenCalled();
    expect(service.untag).not.toHaveBeenCalled();
  });
});
