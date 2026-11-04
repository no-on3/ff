/**
 * L1: Lambda's versions and aliases over FF's: PublishVersion and
 * ListVersionsByFunction; CreateAlias, GetAlias, UpdateAlias, DeleteAlias and
 * ListAliases, each in Lambda's shape, a page at a time where Lambda pages;
 * what they send checked under Lambda's names, and refused as Lambda refuses.
 */
import { ConflictException, NotFoundException, PreconditionFailedException } from '@nestjs/common';
import { FunctionAliasesService } from '../functions/aliases.service';
import { FunctionAliasView } from '../functions/dto/aliases.dto';
import { FunctionVersionView } from '../functions/dto/versions.dto';
import { EventFormat, Function, FunctionStatus, PackageType, Runtime, UpdateStatus } from '../functions/entities/function.entity';
import { FunctionsService } from '../functions/functions.service';
import { FunctionVersionsService } from '../functions/versions.service';
import { awsEndpointsOf } from '../common/aws-endpoint';
import { LambdaVersions } from './lambda-versions';
import { ACCOUNT, REGION, ROLE, lambdaCall, lambdaCaller, refused } from './test-fixtures';

const ARN = `arn:aws:lambda:${REGION}:${ACCOUNT}:function:orders`;
/** Revisions as FF makes them, UUIDs: $LATEST's, and each alias's, by its name. */
const LATEST_REVISION = '6f9619ff-8b86-4d01-b42d-00c04fc964ff';
const revisionOf = (name: string): string => `00000000-0000-4000-8000-${Buffer.from(name).toString('hex').padEnd(12, '0').slice(0, 12)}`;

const fn = (more: Partial<Function> = {}): Function =>
  Object.assign(new Function(), {
    id: 'f-orders',
    accountId: ACCOUNT,
    name: 'orders',
    runtime: Runtime.NODEJS,
    handler: 'index.handler',
    packageType: PackageType.ZIP,
    codeSha256: 'sha-latest',
    codeSize: 1234,
    memory: 256,
    timeout: 30,
    status: FunctionStatus.ACTIVE,
    error: null,
    updateStatus: UpdateStatus.SUCCESSFUL,
    updateReason: null,
    updateStartedAt: null,
    description: 'Orders',
    role: ROLE,
    revisionId: LATEST_REVISION,
    updatedAt: new Date('2026-11-03T10:00:00.000Z'),
    ...more,
  });

const version = (number: number): FunctionVersionView => ({
  functionId: 'f-orders',
  functionArn: `${ARN}:${number}`,
  version: String(number),
  description: `version ${number}`,
  runtime: Runtime.NODEJS,
  handler: 'index.handler',
  packageType: PackageType.ZIP,
  codeSha256: `sha-${number}`,
  codeSize: 100 * number,
  memory: 128,
  timeout: 10,
  eventFormat: EventFormat.LAMBDA,
  awsEndpoints: awsEndpointsOf(),
  revisionId: `rev-${number}`,
  createdAt: new Date('2026-11-01T08:00:00.000Z'),
  environment: { STAGE: `v${number}` },
});

const alias = (name: string, functionVersion: string, more: Partial<FunctionAliasView> = {}): FunctionAliasView => ({
  aliasArn: `${ARN}:${name}`,
  name,
  functionVersion,
  description: '',
  revisionId: revisionOf(name),
  createdAt: new Date('2026-11-01T08:00:00.000Z'),
  updatedAt: new Date('2026-11-01T08:00:00.000Z'),
  ...more,
});

describe("Lambda's versions and aliases (L1)", () => {
  let function_: Function;
  /** The function's versions, by number, and its aliases, by name. */
  let published: number[];
  let aliases: FunctionAliasView[];
  let changing: boolean;
  let functions: { isChanging: jest.Mock; describe: jest.Mock };
  let versions: { publish: jest.Mock; list: jest.Mock; get: jest.Mock };
  let aliasService: { create: jest.Mock; get: jest.Mock; update: jest.Mock; remove: jest.Mock; list: jest.Mock };
  let handlers: LambdaVersions;

  beforeEach(() => {
    function_ = fn();
    published = [1, 3];
    aliases = [alias('live', '3', { routingConfig: { additionalVersionWeights: { '1': 0.25 } } }), alias('edge', '$LATEST'), alias('beta', '1')];
    changing = false;
    functions = { isChanging: jest.fn(() => changing), describe: jest.fn(async () => ({ ...function_, environment: { STAGE: 'latest' } })) };
    versions = {
      publish: jest.fn(async () => {
        published.push(4);
        return version(4);
      }),
      list: jest.fn(async () => published.map(version)),
      get: jest.fn(async (_account: string, _id: string, number: number) => version(number)),
    };
    const named = (name: string) => {
      const found = aliases.find((candidate) => candidate.name === name);
      if (!found) throw new NotFoundException('The function orders has no alias');
      return found;
    };
    aliasService = {
      create: jest.fn(async (_account: string, _id: string, sent: { name: string; functionVersion: string }) => {
        if (aliases.some((candidate) => candidate.name === sent.name)) throw new ConflictException('taken');
        return alias(sent.name, sent.functionVersion, sent);
      }),
      get: jest.fn(async (_account: string, _id: string, name: string) => named(name)),
      update: jest.fn(async (_account: string, _id: string, name: string, sent: Partial<FunctionAliasView>) => ({ ...named(name), ...sent, revisionId: revisionOf('new') })),
      remove: jest.fn(async (_account: string, _id: string, name: string) => void named(name)),
      list: jest.fn(async () => [...aliases].sort((a, b) => a.name.localeCompare(b.name))),
    };
    handlers = new LambdaVersions(
      functions as unknown as FunctionsService,
      versions as unknown as FunctionVersionsService,
      aliasService as unknown as FunctionAliasesService,
    );
  });

  /** A request as the front door hands it on: the function its path names found, a qualifier with its name if one. */
  async function ask(method: string, target: string, input: Record<string, unknown> = {}, qualifier?: string) {
    const call = lambdaCall(method, target, input);
    const answer = await handlers.handlers[call.operation.name](call, lambdaCaller({ function_, named: { name: 'orders', ...(qualifier ? { qualifier } : {}) } }));
    return { status: answer.status, document: answer.document as Record<string, unknown> };
  }

  const VERSIONS = '/2015-03-31/functions/orders/versions';
  const ALIASES = '/2015-03-31/functions/orders/aliases';

  describe('PublishVersion', () => {
    it("publishes the function as it is, and answers 201 with the version's configuration, its variables as published", async () => {
      const answer = await ask('POST', VERSIONS, { Description: 'Receipts in French', CodeSha256: 'sha-latest', RevisionId: LATEST_REVISION });

      expect(versions.publish).toHaveBeenCalledWith(ACCOUNT, 'f-orders', { description: 'Receipts in French', codeSha256: 'sha-latest', revisionId: LATEST_REVISION });
      expect(answer.status).toBe(201);
      expect(answer.document).toMatchObject({
        FunctionName: 'orders',
        FunctionArn: `${ARN}:4`,
        Version: '4',
        CodeSha256: 'sha-4',
        Environment: { Variables: { STAGE: 'v4' } },
        State: 'Active',
      });
    });

    it('sends none of what was not sent, which FF checks only when given', async () => {
      await ask('POST', VERSIONS);

      expect(versions.publish).toHaveBeenCalledWith(ACCOUNT, 'f-orders', {});
    });

    it('is refused while the function is created or changed, or Failed, as Lambda refuses it, which the tools wait out', async () => {
      function_ = fn({ status: FunctionStatus.CREATING });
      expect(await refused(ask('POST', VERSIONS))).toEqual([
        409,
        'ResourceConflictException',
        'The operation cannot be performed at this time. The function is currently in the following state: Pending',
      ]);
      function_ = fn();
      changing = true;
      expect(await refused(ask('POST', VERSIONS))).toEqual([
        409,
        'ResourceConflictException',
        `The operation cannot be performed at this time. An update is in progress for resource: ${ARN}`,
      ]);
      changing = false;
      function_ = fn({ status: FunctionStatus.ERROR });
      expect(await refused(ask('POST', VERSIONS))).toEqual([
        409,
        'ResourceConflictException',
        'The operation cannot be performed at this time. The function is currently in the following state: Failed',
      ]);
      expect(versions.publish).not.toHaveBeenCalled();
    });

    it("is refused for code that isn't $LATEST's, a revision another change came after, a field FF doesn't take, or a version named", async () => {
      expect(await refused(ask('POST', VERSIONS, { CodeSha256: 'sha-other' }))).toEqual([
        400,
        'InvalidParameterValueException',
        'CodeSHA256 (sha-other) is different from current CodeSHA256 in $LATEST (sha-latest). Please try again.',
      ]);
      expect((await refused(ask('POST', VERSIONS, { RevisionId: 'rev-old' })))[0]).toBe(412);
      expect(await refused(ask('POST', VERSIONS, { Publish: true }))).toEqual([400, 'InvalidParameterValueException', "FF doesn't take Publish in PublishVersion."]);
      expect(await refused(ask('POST', VERSIONS, { Description: 7 }))).toEqual([400, 'InvalidParameterValueException', 'Description must be a string.']);
      expect(await refused(ask('POST', VERSIONS, {}, '3'))).toEqual([
        400,
        'InvalidParameterValueException',
        'PublishVersion names the function alone, not its version or alias 3: send orders.',
      ]);
      expect(versions.publish).not.toHaveBeenCalled();
    });
  });

  describe('ListVersionsByFunction', () => {
    it('lists $LATEST, then each version, oldest first, a page at a time', async () => {
      const first = await ask('GET', `${VERSIONS}?MaxItems=2`);
      const second = await ask('GET', `${VERSIONS}?MaxItems=2&Marker=${String(first.document.NextMarker)}`);

      const versionsOf = (page: Record<string, unknown>) => (page.Versions as Array<Record<string, unknown>>).map((entry) => [entry.Version, entry.FunctionArn]);
      expect(versionsOf(first.document)).toEqual([
        // $LATEST's ARN is the function's, as Lambda gives it.
        ['$LATEST', ARN],
        ['1', `${ARN}:1`],
      ]);
      expect(versionsOf(second.document)).toEqual([['3', `${ARN}:3`]]);
      expect(second.document).not.toHaveProperty('NextMarker');
      expect((first.document.Versions as unknown[])[0]).toMatchObject({ Environment: { Variables: { STAGE: 'latest' } } });
    });

    it('refuses a marker no page gave', async () => {
      expect(await refused(ask('GET', `${VERSIONS}?Marker=bm9wZQ`))).toEqual([400, 'InvalidParameterValueException', 'Marker is not one that ListVersionsByFunction gave.']);
    });
  });

  describe('aliases', () => {
    it("CreateAlias makes one, with another version's share of the calls, and answers 201 with Lambda's AliasConfiguration", async () => {
      const answer = await ask('POST', ALIASES, { Name: 'canary', FunctionVersion: '3', Description: 'Next', RoutingConfig: { AdditionalVersionWeights: { '1': 0.1 } } });

      expect(aliasService.create).toHaveBeenCalledWith(ACCOUNT, 'f-orders', {
        name: 'canary',
        functionVersion: '3',
        description: 'Next',
        routingConfig: { additionalVersionWeights: { '1': 0.1 } },
      });
      expect(answer).toEqual({
        status: 201,
        document: {
          AliasArn: `${ARN}:canary`,
          Name: 'canary',
          FunctionVersion: '3',
          Description: 'Next',
          RoutingConfig: { AdditionalVersionWeights: { '1': 0.1 } },
          RevisionId: revisionOf('canary'),
        },
      });
    });

    it('CreateAlias is refused for a name taken, a version the function hasn\'t, and what Lambda refuses', async () => {
      expect(await refused(ask('POST', ALIASES, { Name: 'live', FunctionVersion: '1' }))).toEqual([409, 'ResourceConflictException', `Alias already exists: ${ARN}:live`]);
      expect(await refused(ask('POST', ALIASES, { Name: 'next', FunctionVersion: '7' }))).toEqual([404, 'ResourceNotFoundException', `Function not found: ${ARN}:7`]);
      expect(await refused(ask('POST', ALIASES, { Name: 'next', FunctionVersion: '3', RoutingConfig: { AdditionalVersionWeights: { '9': 0.5 } } }))).toEqual([
        404,
        'ResourceNotFoundException',
        `Function not found: ${ARN}:9`,
      ]);
      const invalid = (input: Record<string, unknown>) => refused(ask('POST', ALIASES, input)).then(([, , message]) => message);
      expect(await invalid({ Name: '12', FunctionVersion: '1' })).toBe('Name must be 1 to 128 letters, digits, - and _, not digits alone, which name a version.');
      expect(await invalid({ Name: 'next' })).toBe("CreateAlias needs FunctionVersion: $LATEST or a version's number.");
      expect(await invalid({ Name: 'next', FunctionVersion: 'latest' })).toBe("FunctionVersion must be $LATEST or a version's number, not latest.");
      for (const RoutingConfig of [{ AdditionalVersionWeights: { '1': 0.1, '3': 0.1 } }, { AdditionalVersionWeights: { '1': 2 } }, { Other: {} }, []]) {
        expect(await invalid({ Name: 'next', FunctionVersion: '3', RoutingConfig })).toBe(
          'RoutingConfig.AdditionalVersionWeights names at most one version, by its number, with its share of the calls from 0 to 1.',
        );
      }
      expect(await invalid({ Name: 'next', FunctionVersion: '3', Tags: {} })).toBe("FF doesn't take Tags in CreateAlias.");
      expect(aliasService.create).toHaveBeenCalledTimes(1);
    });

    it('GetAlias reads one; one the function hasn\'t is Lambda\'s "Alias not found", with its ARN', async () => {
      expect((await ask('GET', `${ALIASES}/live`)).document).toEqual({
        AliasArn: `${ARN}:live`,
        Name: 'live',
        FunctionVersion: '3',
        Description: '',
        RoutingConfig: { AdditionalVersionWeights: { '1': 0.25 } },
        RevisionId: revisionOf('live'),
      });
      expect((await ask('GET', `${ALIASES}/edge`)).document).not.toHaveProperty('RoutingConfig');
      expect(await refused(ask('GET', `${ALIASES}/gone`))).toEqual([404, 'ResourceNotFoundException', `Alias not found: ${ARN}:gone`]);
    });

    it('UpdateAlias changes what it sends, and passes RevisionId on for FF to check; an alias the function hasn\'t is refused first', async () => {
      const answer = await ask('PUT', `${ALIASES}/live`, { FunctionVersion: '1', RoutingConfig: { AdditionalVersionWeights: {} }, RevisionId: revisionOf('live') });

      expect(aliasService.update).toHaveBeenCalledWith(ACCOUNT, 'f-orders', 'live', {
        functionVersion: '1',
        routingConfig: { additionalVersionWeights: {} },
        revisionId: revisionOf('live'),
      });
      expect(answer.document).toMatchObject({ Name: 'live', FunctionVersion: '1', RevisionId: revisionOf('new') });
      // Any revision but the alias's is one another change came after, Lambda's or not; FF checks it again under its lock.
      expect((await refused(ask('PUT', `${ALIASES}/live`, { RevisionId: 'rev-old' })))[1]).toBe('PreconditionFailedException');
      aliasService.update.mockRejectedValueOnce(new PreconditionFailedException('another change came between'));
      expect((await refused(ask('PUT', `${ALIASES}/live`, { RevisionId: revisionOf('live') })))[1]).toBe('PreconditionFailedException');
      expect(aliasService.update).toHaveBeenCalledTimes(2);
      expect(await refused(ask('PUT', `${ALIASES}/gone`, { Description: 'x' }))).toEqual([404, 'ResourceNotFoundException', `Alias not found: ${ARN}:gone`]);
      expect(await refused(ask('PUT', `${ALIASES}/live`, { FunctionVersion: '8' }))).toEqual([404, 'ResourceNotFoundException', `Function not found: ${ARN}:8`]);
      expect(await refused(ask('PUT', `${ALIASES}/live`, { Name: 'other' }))).toEqual([400, 'InvalidParameterValueException', "FF doesn't take Name in UpdateAlias."]);
    });

    it('DeleteAlias deletes it, 204; the versions it named stay', async () => {
      expect(await ask('DELETE', `${ALIASES}/beta`)).toEqual({ status: 204, document: undefined });
      expect(aliasService.remove).toHaveBeenCalledWith(ACCOUNT, 'f-orders', 'beta');
      expect(await refused(ask('DELETE', `${ALIASES}/gone`))).toEqual([404, 'ResourceNotFoundException', `Alias not found: ${ARN}:gone`]);
    });

    it('ListAliases lists them by name, a page at a time; with FunctionVersion, those pointing at it', async () => {
      const first = await ask('GET', `${ALIASES}?MaxItems=2`);
      const names = (page: Record<string, unknown>) => (page.Aliases as Array<Record<string, unknown>>).map((entry) => entry.Name);

      expect(names(first.document)).toEqual(['beta', 'edge']);
      expect(names((await ask('GET', `${ALIASES}?MaxItems=2&Marker=${String(first.document.NextMarker)}`)).document)).toEqual(['live']);
      expect(names((await ask('GET', `${ALIASES}?FunctionVersion=$LATEST`)).document)).toEqual(['edge']);
      expect(await refused(ask('GET', `${ALIASES}?FunctionVersion=newest`))).toEqual([
        400,
        'InvalidParameterValueException',
        "FunctionVersion must be $LATEST or a version's number, not newest.",
      ]);
    });
  });
});
