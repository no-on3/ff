import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LAMBDA_OPERATIONS, LATER_OPERATIONS, laterOperationOf, operationOf } from './lambda-operations';

/** Lambda's operations as botocore's model has them: each one's name, method and URI, its labels in braces. */
const model = JSON.parse(readFileSync(join(__dirname, 'lambda-api-model/operations.json'), 'utf8')) as {
  operations: Array<{ name: string; method: string; uri: string }>;
};

/** An ARN, escaped as AWS's SDKs escape a label of a path. */
const arn = (resource: string) => encodeURIComponent(`arn:aws:lambda:tn-tunis-1:000000000001:${resource}`);

/** A value for each label of the model's paths, as a client sends it. */
const LABELS: Record<string, string> = {
  FunctionName: 'orders',
  Name: 'live',
  StatementId: 'allow-s3',
  UUID: '0b6f3b5e-1b9c-4c55-9b0a-3f2d6b1e8a71',
  Resource: arn('function:orders'),
  LayerName: 'shared',
  VersionNumber: '1',
  CodeSigningConfigArn: arn('code-signing-config:csc-0123456789abcdef0'),
  CapacityProviderName: 'pool',
  CallbackId: 'callback-1',
  DurableExecutionArn: arn('function:orders:1/durable-execution/run-1/0b6f3b5e'),
  ResourceArn: arn('function:orders'),
};

/** The request a client makes for an operation of the model: its path, each label given a value, and its query. */
function requestOf(uri: string): { path: string; query: string } {
  const [path, query = ''] = uri.split('?');
  return {
    path: path.replace(/\{([A-Za-z]+)\+?\}/g, (_, label: string) => {
      if (!(label in LABELS)) throw new Error(`No value for the label ${label}: give it one in LABELS`);
      return LABELS[label];
    }),
    query,
  };
}

/** The operation FF finds a request makes, among the 41 or the others, by its name. */
const nameOf = (method: string, path: string, query: string) => operationOf(method, path)?.operation.name ?? laterOperationOf(method, path, query)?.name;

describe("Lambda's operations, as its model has them", () => {
  it("are the 41 FF takes and the 47 it doesn't offer yet, each once", () => {
    const names = model.operations.map((operation) => operation.name).sort();

    expect([...LAMBDA_OPERATIONS, ...LATER_OPERATIONS].map((operation) => operation.name).sort()).toEqual(names);
    expect([LAMBDA_OPERATIONS.length, LATER_OPERATIONS.length, names.length]).toEqual([41, 47, 88]);
  });

  it('are each found by its method, its path and its query, as a client sends them', () => {
    const found = model.operations.map(({ method, uri }) => {
      const { path, query } = requestOf(uri);
      return nameOf(method, path, query);
    });

    expect(found).toEqual(model.operations.map((operation) => operation.name));
  });

  it('tell the two of a path apart by its query alone, whatever else the query holds', () => {
    expect(laterOperationOf('GET', '/2018-10-31/layers', 'CompatibleRuntime=nodejs24.x')?.name).toBe('ListLayers');
    expect(laterOperationOf('GET', '/2018-10-31/layers', `Arn=${arn('layer:shared:1')}&find=LayerVersion`)?.name).toBe('GetLayerVersionByArn');
    expect(laterOperationOf('GET', '/2019-09-30/functions/orders/provisioned-concurrency', 'Qualifier=live')?.name).toBe('GetProvisionedConcurrencyConfig');
    expect(laterOperationOf('GET', '/2019-09-30/functions/orders/provisioned-concurrency', 'MaxItems=5&List=ALL')?.name).toBe('ListProvisionedConcurrencyConfigs');
  });

  it("find none for a request that is none of Lambda's: another path, another method, a segment more", () => {
    expect(laterOperationOf('GET', '/2018-10-31/layerz', '')).toBeNull();
    expect(laterOperationOf('PATCH', '/2018-10-31/layers', '')).toBeNull();
    expect(laterOperationOf('GET', '/2018-10-31/layers/shared/versions/1/policy/allow/more', '')).toBeNull();
  });

  it("are each named in the guide's section on Lambda's API", () => {
    const guide = readFileSync(join(__dirname, '../../../docs/getting-started.md'), 'utf8');
    const start = guide.indexOf("### Functions through Lambda's API");
    const section = guide.slice(start, guide.indexOf('\n### ', start + 1));

    expect(start).toBeGreaterThan(0);
    expect(model.operations.map((operation) => operation.name).filter((name) => !section.includes(`\`${name}\``))).toEqual([]);
  });
});
