import { Injectable, NotFoundException } from '@nestjs/common';
import { functionArn, qualifiedFunctionArn } from '../functions/arns';
import { FunctionVersionView } from '../functions/dto/versions.dto';
import { Function, FunctionStatus, Runtime } from '../functions/entities/function.entity';
import { FunctionAliasesService } from '../functions/aliases.service';
import { FunctionsService } from '../functions/functions.service';
import { FunctionVersionsService } from '../functions/versions.service';
import { PACKAGE_LIMITS } from '../packages/package-archive';
import { PackagesService } from '../packages/packages.service';
import { invalidParameterValue, resourceNotFound } from './lambda-error';
import { LambdaCodeLinks } from './lambda-code-links';
import { LambdaAnswer, LambdaCall, LambdaCaller, LambdaHandler } from './lambda-operations';

/** FF's two runtimes under Lambda's names (ADR 0014, 7). */
export const LAMBDA_RUNTIMES: Record<Runtime, string> = {
  [Runtime.NODEJS]: 'nodejs24.x',
  [Runtime.PYTHON]: 'python3.13',
};

/** A time as Lambda writes `LastModified`: ISO 8601 with milliseconds, its zone as +0000. */
export const lambdaTime = (date: Date): string => date.toISOString().replace('Z', '+0000');

/** The most functions a page of ListFunctions holds, and the default, as Lambda's. */
const LIST_MAX = 10_000;
const LIST_DEFAULT = 50;

/** What Lambda's FunctionConfiguration says of a function's state and its last change. */
type States = Record<'State' | 'LastUpdateStatus', string> & Partial<Record<'StateReason' | 'StateReasonCode' | 'LastUpdateStatusReason' | 'LastUpdateStatusReasonCode', string>>;

const CREATING = 'The function is being created.';

/**
 * A function's state as Lambda's: a deploy under way is `Pending`, a working
 * function `Active`, one whose deploy failed `Failed` with FF's diagnosis as its
 * reason; its last change as `LastUpdateStatus`, the same way.
 */
export function statesOf(function_: Pick<Function, 'status' | 'error'>): States {
  switch (function_.status) {
    case FunctionStatus.CREATING:
      return {
        State: 'Pending',
        StateReason: CREATING,
        StateReasonCode: 'Creating',
        LastUpdateStatus: 'InProgress',
        LastUpdateStatusReason: CREATING,
        LastUpdateStatusReasonCode: 'Creating',
      };
    case FunctionStatus.ACTIVE:
      return { State: 'Active', LastUpdateStatus: 'Successful' };
    default: {
      const reason = function_.error ?? 'The function could not be deployed.';
      return {
        State: 'Failed',
        StateReason: reason,
        StateReasonCode: 'InvalidConfiguration',
        LastUpdateStatus: 'Failed',
        LastUpdateStatusReason: reason,
        LastUpdateStatusReasonCode: 'InvalidConfiguration',
      };
    }
  }
}

/** What $LATEST and a version show alike: the code and the settings it runs with, and those FF has only one of. */
interface Settings {
  name: string;
  runtime: Runtime;
  handler: string;
  codeSize: number;
  codeSha256: string;
  timeout: number;
  memory: number;
  description: string;
  variables?: Record<string, string>;
}

function settingsOf(settings: Settings): Record<string, unknown> {
  return {
    Runtime: LAMBDA_RUNTIMES[settings.runtime],
    Handler: settings.handler,
    CodeSize: settings.codeSize,
    Description: settings.description,
    Timeout: settings.timeout,
    MemorySize: settings.memory,
    CodeSha256: settings.codeSha256,
    ...(settings.variables && Object.keys(settings.variables).length > 0 ? { Environment: { Variables: settings.variables } } : {}),
    // X-Ray isn't FF's: calls pass a trace header through, as Lambda's PassThrough does.
    TracingConfig: { Mode: 'PassThrough' },
    PackageType: 'Zip',
    Architectures: ['x86_64'],
    // A function's /tmp, which FF gives every one.
    EphemeralStorage: { Size: 512 },
    SnapStart: { ApplyOn: 'None', OptimizationStatus: 'Off' },
    LoggingConfig: { LogFormat: 'Text', LogGroup: `/aws/lambda/${settings.name}` },
  };
}

/** $LATEST's configuration, as Lambda's GetFunctionConfiguration answers it: its variables, never its secrets. */
export function latestConfiguration(function_: Function, region: string, variables?: Record<string, string>): Record<string, unknown> {
  return {
    FunctionName: function_.name,
    FunctionArn: functionArn(region, function_.accountId, function_.name),
    ...settingsOf({ ...function_, description: '', variables }),
    LastModified: lambdaTime(function_.updatedAt),
    Version: '$LATEST',
    RevisionId: function_.revisionId,
    ...statesOf(function_),
  };
}

/** A version's configuration: what was published, which never changes, so always Active. */
export function versionConfiguration(function_: Pick<Function, 'name'>, version: FunctionVersionView): Record<string, unknown> {
  return {
    FunctionName: function_.name,
    FunctionArn: version.functionArn,
    ...settingsOf({ ...version, name: function_.name, variables: version.environment }),
    LastModified: lambdaTime(new Date(version.createdAt)),
    Version: version.version,
    RevisionId: version.revisionId,
    State: 'Active',
    LastUpdateStatus: 'Successful',
  };
}

/** A page's place in ListFunctions: the last entry given, a function's name and its version's number, if one. */
type Place = [name: string, version: number | null];

const markerOf = (place: Place): string => Buffer.from(JSON.stringify(place), 'utf8').toString('base64url');

function placeOf(marker: string): Place {
  try {
    const place: unknown = JSON.parse(Buffer.from(marker, 'base64url').toString('utf8'));
    if (Array.isArray(place) && place.length === 2 && typeof place[0] === 'string' && (place[1] === null || Number.isInteger(place[1]))) return place as Place;
  } catch {
    // Not one of FF's markers: refused below.
  }
  throw invalidParameterValue('Marker is not one that ListFunctions gave.');
}

const after = (entry: Place, place: Place): boolean =>
  entry[0] > place[0] || (entry[0] === place[0] && (entry[1] ?? 0) > (place[1] ?? 0));

/**
 * Lambda's reads of functions over FF's (ADR 0014, 2): GetFunction,
 * GetFunctionConfiguration, ListFunctions, GetFunctionCodeSigningConfig and
 * GetAccountSettings. A qualifier names $LATEST, a version or an alias, whose
 * version is read; the code comes as a link of FF's, good for 10 minutes.
 */
@Injectable()
export class LambdaFunctionReads {
  constructor(
    private readonly functions: FunctionsService,
    private readonly versions: FunctionVersionsService,
    private readonly aliases: FunctionAliasesService,
    private readonly packages: PackagesService,
    private readonly links: LambdaCodeLinks,
  ) {}

  readonly handlers: Record<string, LambdaHandler> = {
    GetFunction: (_call, caller) => this.getFunction(caller),
    GetFunctionConfiguration: async (_call, caller) => ok((await this.configuration(caller)).configuration),
    ListFunctions: (call, caller) => this.listFunctions(call, caller),
    // FF signs no code: there is no configuration, which Terraform's provider reads as none.
    GetFunctionCodeSigningConfig: (_call, caller) => Promise.resolve(ok({ CodeSigningConfigArn: '', FunctionName: found(caller).name })),
    GetAccountSettings: (_call, caller) => this.accountSettings(caller),
  };

  private async getFunction(caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = found(caller);
    const { configuration, version } = await this.configuration(caller);
    const location = this.links.linkFor({ accountId: caller.accountId, functionId: function_.id, ...(version !== undefined ? { version } : {}) });
    return ok({ Configuration: configuration, Code: { RepositoryType: 'S3', Location: location } });
  }

  /** The configuration that the request's qualifier names, and the version it is, none for $LATEST. */
  private async configuration(caller: LambdaCaller): Promise<{ configuration: Record<string, unknown>; version?: number }> {
    const function_ = found(caller);
    const qualifier = caller.named?.qualifier;
    const missing = () => resourceNotFound(`Function not found: ${qualifiedFunctionArn(caller.region, caller.accountId, function_.name, qualifier)}`);
    let version = qualifier === undefined || qualifier === '$LATEST' ? undefined : Number(qualifier);
    if (qualifier !== undefined && version !== undefined && !Number.isInteger(version)) {
      const alias = await notFoundAs(this.aliases.get(caller.accountId, function_.id, qualifier), missing);
      version = alias.functionVersion === '$LATEST' ? undefined : Number(alias.functionVersion);
    }
    if (version === undefined) {
      const view = await this.functions.describe(caller.accountId, function_.id);
      return { configuration: latestConfiguration(function_, caller.region, view.environment) };
    }
    const published = await notFoundAs(this.versions.get(caller.accountId, function_.id, version), missing);
    return { configuration: versionConfiguration(function_, published), version };
  }

  /**
   * The account's functions that the key may read, by name, a page at a time
   * (MaxItems, 50 by default; Marker, the page's NextMarker); with
   * FunctionVersion=ALL, each one's versions after it.
   */
  private async listFunctions({ query }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const all = query.get('FunctionVersion');
    if (all !== null && all !== 'ALL') throw invalidParameterValue(`FunctionVersion must be ALL, not ${all}.`);
    if (query.get('MasterRegion') !== null) throw invalidParameterValue("MasterRegion names a Lambda@Edge function's replicas: FF has none.");
    const sent = query.get('MaxItems');
    const size = sent === null ? LIST_DEFAULT : Number(sent);
    if (!Number.isInteger(size) || size < 1 || size > LIST_MAX) throw invalidParameterValue(`MaxItems must be a whole number from 1 to ${LIST_MAX}, not ${sent}.`);
    const marker = query.get('Marker');
    const place = marker === null ? undefined : placeOf(marker);

    const readable = (await this.functions.findAll(caller.accountId))
      .filter((function_) => function_.status !== FunctionStatus.DELETED && caller.mayUse(function_.name, 'read'))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const entries: Array<{ function_: Function; place: Place }> = [];
    for (const function_ of readable) {
      entries.push({ function_, place: [function_.name, null] });
      if (all === null) continue;
      const numbers = (await this.versions.list(caller.accountId, function_.id)).map((version) => Number(version.version)).sort((a, b) => a - b);
      for (const number of numbers) entries.push({ function_, place: [function_.name, number] });
    }
    const rest = place ? entries.filter((entry) => after(entry.place, place)) : entries;
    const page = rest.slice(0, size);
    const configurations = [];
    for (const { function_, place: [, version] } of page) {
      if (version === null) {
        const view = await this.functions.describe(caller.accountId, function_.id);
        configurations.push(latestConfiguration(function_, caller.region, view.environment));
      } else {
        configurations.push(versionConfiguration(function_, await this.versions.get(caller.accountId, function_.id, version)));
      }
    }
    const last = page.at(-1);
    return ok({ Functions: configurations, ...(rest.length > page.length && last ? { NextMarker: markerOf(last.place) } : {}) });
  }

  /** The plan's limits under Lambda's names, and what the account uses: its packages each once, and its functions. */
  private async accountSettings(caller: LambdaCaller): Promise<LambdaAnswer> {
    const { limits } = caller.plan;
    const functions = await this.functions.findAll(caller.accountId);
    // Each instance serves one call at a time, and the account's namespace runs this many pods at most.
    const concurrent = limits.quota.pods;
    return ok({
      AccountLimit: {
        TotalCodeSize: limits.codeStorageMb * 1024 * 1024,
        CodeSizeUnzipped: PACKAGE_LIMITS.unpackedBytes,
        CodeSizeZipped: PACKAGE_LIMITS.zipBytes,
        ConcurrentExecutions: concurrent,
        UnreservedConcurrentExecutions: concurrent,
      },
      AccountUsage: {
        TotalCodeSize: await this.packages.namedBytes(caller.accountId),
        FunctionCount: functions.filter((function_) => function_.status !== FunctionStatus.DELETED).length,
      },
    });
  }
}

const ok = (document: unknown): LambdaAnswer => ({ status: 200, document });

/** The function the front door found where the path names one. */
function found(caller: LambdaCaller): Function {
  if (!caller.function_) throw new Error('The front door finds the function a path names before its operation runs');
  return caller.function_;
}

/** A lookup whose NotFoundException, FF's API's, is Lambda's ResourceNotFoundException instead. */
async function notFoundAs<T>(lookup: Promise<T>, missing: () => Error): Promise<T> {
  try {
    return await lookup;
  } catch (error) {
    if (error instanceof NotFoundException) throw missing();
    throw error;
  }
}
