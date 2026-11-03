import { parseFunctionName } from '../functions/arns';
import { handlerSyntaxProblem } from '../functions/code-package';
import { CreateFunctionDto } from '../functions/dto/create-function.dto';
import { UpdateFunctionDto } from '../functions/dto/update-function.dto';
import { Function, Runtime } from '../functions/entities/function.entity';
import { environmentProblems } from '../functions/environment';
import { LambdaUpdateFields } from '../functions/functions.service';
import { PLATFORM_LIMITS, PlanView } from '../plans/plan-limits';
import { tagsProblem } from '../tags/tag-rules';
import { invalidParameterValue } from './lambda-error';
import { defined, isObject, refuseUnknownFields, said } from './lambda-fields';
import { LAMBDA_RUNTIMES } from './lambda-functions';
import { LambdaCaller } from './lambda-operations';
import { tagsOf } from './lambda-tags';

/** FF's runtime by Lambda's name for it. */
const RUNTIME_NAMED = new Map<string, Runtime>(Object.entries(LAMBDA_RUNTIMES).map(([runtime, name]) => [name, runtime as Runtime]));
const RUNTIMES = [...RUNTIME_NAMED.keys()].join(' or ');

/** An IAM role's ARN, as Lambda's model checks Role. */
const IAM_ROLE = /^arn:(aws[a-zA-Z-]*)?:iam::\d{12}:role\/?[a-zA-Z_0-9+=,.@\-/]+$/;
const ROLE_MAX = 2048;
const DESCRIPTION_MAX = 256;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Lambda's defaults, for a create that sends none. */
const DEFAULT_MEMORY_MB = 128;
const DEFAULT_TIMEOUT_SECONDS = 3;

const KMS = 'FF seals what it keeps with its own keys: a KMS key has no place here.';
const IMAGES = 'FF runs .zip packages, not container images.';

/**
 * What would change what runs and FF can't do: refused, saying why, unless
 * sent empty, as the tools send a default.
 */
const REFUSED: Record<string, string> = {
  VpcConfig: "FF's functions need no VPC: each one reaches its account's buckets, queues and databases without one.",
  Layers: "FF has no layers: put the libraries in the function's zip.",
  KMSKeyArn: KMS,
  FileSystemConfigs: "FF mounts no file system: a function has FF's 512 MB of /tmp.",
  ImageConfig: IMAGES,
  CodeSigningConfigArn: 'FF signs no code.',
  DeadLetterConfig: "FF doesn't send failed events to a dead-letter queue yet.",
};

/** The settings at the one value FF has, which a create and an update of the configuration take as that value. */
const ONE_VALUE = ['TracingConfig', 'EphemeralStorage', 'SnapStart', 'LoggingConfig'];

/** The fields each operation takes. */
const TAKEN: Record<'CreateFunction' | 'UpdateFunctionConfiguration' | 'UpdateFunctionCode', Set<string>> = {
  CreateFunction: new Set([
    'FunctionName',
    'Runtime',
    'Role',
    'Handler',
    'Code',
    'Description',
    'Timeout',
    'MemorySize',
    'Publish',
    'PackageType',
    'Environment',
    'Tags',
    'Architectures',
    ...ONE_VALUE,
    ...Object.keys(REFUSED),
  ]),
  UpdateFunctionConfiguration: new Set(['Runtime', 'Role', 'Handler', 'Description', 'Timeout', 'MemorySize', 'Environment', 'RevisionId', ...ONE_VALUE, ...Object.keys(REFUSED)]),
  UpdateFunctionCode: new Set(['ZipFile', 'S3Bucket', 'S3Key', 'S3ObjectVersion', 'ImageUri', 'SourceKMSKeyArn', 'Publish', 'DryRun', 'RevisionId', 'Architectures']),
};

type Operation = keyof typeof TAKEN;

/** Where a request's code is: the zip itself, or a bucket of the account and its key. */
export type CodeSource = { zip: Buffer } | { bucket: string; key: string };

/** What CreateFunction asks for, checked, in FF's terms. */
export interface CreateFunctionRequest {
  /** FF's create but its code, which comes as a package once the zip is stored. */
  fields: Omit<CreateFunctionDto, 'code' | 'codeSha256'>;
  code: CodeSource;
  description: string;
  role: string;
  tags?: Record<string, string>;
  publish: boolean;
}

/** What UpdateFunctionConfiguration asks for, checked: FF's update, and Lambda's fields beside it. */
export interface ConfigurationChange {
  fields: Pick<UpdateFunctionDto, 'runtime' | 'handler' | 'memory' | 'timeout' | 'environment'>;
  lambda: LambdaUpdateFields;
}

/** What UpdateFunctionCode asks for, checked. */
export interface CodeChange {
  code: CodeSource;
  publish: boolean;
  /** Every check made, nothing changed, as Lambda's DryRun. */
  dryRun: boolean;
  revisionId?: string;
}

/** Sent with nothing in it: absent, null, false, empty, or an object of such, as the tools send a setting left at its default. */
const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || value === false || value === '' || (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.values(value).every(isEmpty));

/**
 * A whole number from `min` to `max`, Lambda's bounds, and within the plan's,
 * said apart, unless it is the function's `current` value, which an older,
 * larger plan gave it; undefined when not sent.
 */
function wholeNumber(
  input: Record<string, unknown>,
  field: string,
  unit: string,
  [min, max]: [number, number],
  plan: { limit: number; name: string },
  current?: number,
): number | undefined {
  const sent = input[field];
  if (sent === undefined) return undefined;
  if (typeof sent !== 'number' || !Number.isInteger(sent) || sent < min || sent > max) {
    throw invalidParameterValue(`${field} must be a whole number of ${unit} from ${min} to ${max}, not ${JSON.stringify(sent)}.`);
  }
  if (sent > plan.limit && sent !== current) throw invalidParameterValue(`${field} must be at most ${plan.limit} ${unit} on the ${plan.name} plan.`);
  return sent;
}

/** FF runs x86_64 alone. */
function refuseArchitectures(architectures: unknown): void {
  if (architectures !== undefined && !(Array.isArray(architectures) && architectures.every((architecture) => architecture === 'x86_64'))) {
    throw invalidParameterValue('FF runs x86_64 alone: Architectures must be [x86_64].');
  }
}

const refuseUnknown = (input: Record<string, unknown>, operation: Operation): void => refuseUnknownFields(input, operation, TAKEN[operation]);

/** The settings FF has one value of: sent as that value, or not at all; those it can't do refused, unless sent empty. */
function refuseOtherSettings(input: Record<string, unknown>, name: string, operation: Operation): void {
  if (input.PackageType !== undefined && input.PackageType !== 'Zip') throw invalidParameterValue(`${IMAGES} PackageType must be Zip.`);
  refuseArchitectures(input.Architectures);
  const storage = input.EphemeralStorage;
  if (storage !== undefined && !(isObject(storage) && storage.Size === 512 && Object.keys(storage).length === 1)) {
    throw invalidParameterValue("A function's /tmp holds 512 MB on FF: EphemeralStorage.Size must be 512.");
  }
  const tracing = input.TracingConfig;
  if (tracing !== undefined && !(isObject(tracing) && Object.keys(tracing).every((key) => key === 'Mode') && [undefined, 'PassThrough'].includes(tracing.Mode as string))) {
    throw invalidParameterValue('FF has no X-Ray: TracingConfig.Mode must be PassThrough, which passes a trace header on.');
  }
  const snapStart = input.SnapStart;
  if (snapStart !== undefined && !(isObject(snapStart) && Object.keys(snapStart).every((key) => key === 'ApplyOn') && [undefined, 'None'].includes(snapStart.ApplyOn as string))) {
    throw invalidParameterValue('FF has no SnapStart: SnapStart.ApplyOn must be None.');
  }
  const logging = input.LoggingConfig;
  if (logging !== undefined) {
    const group = `/aws/lambda/${name}`;
    const fits =
      isObject(logging) &&
      Object.keys(logging).every((key) => key === 'LogFormat' || key === 'LogGroup') &&
      [undefined, 'Text'].includes(logging.LogFormat as string) &&
      [undefined, group].includes(logging.LogGroup as string);
    if (!fits) throw invalidParameterValue(`FF's logs are text, in the log group ${group}: LoggingConfig takes LogFormat Text and that LogGroup alone.`);
  }
  for (const [field, why] of Object.entries(REFUSED)) {
    if (!isEmpty(input[field])) throw invalidParameterValue(`${why} Send ${operation} without ${field}.`);
  }
  refuseUnknown(input, operation);
}

/**
 * The code a request names: a zip in base64, or where one is, in a bucket of
 * the account; never an image, an object's version, or a KMS key. `holder`
 * holds its fields, at `prefix`: CreateFunction's Code, or UpdateFunctionCode
 * itself.
 */
function codeSourceOf(sent: Record<string, unknown>, holder: string, prefix: string): CodeSource {
  if (sent.ImageUri !== undefined) throw invalidParameterValue(`${IMAGES} Send ${prefix}ZipFile, or ${prefix}S3Bucket and S3Key.`);
  if (sent.S3ObjectVersion !== undefined) throw invalidParameterValue(`FF's buckets keep no object versions: send ${holder} without S3ObjectVersion.`);
  if (sent.SourceKMSKeyArn !== undefined) throw invalidParameterValue(`${KMS} Send ${holder} without SourceKMSKeyArn.`);
  const { ZipFile: zip, S3Bucket: bucket, S3Key: key } = sent;
  if (zip === undefined && bucket === undefined && key === undefined) {
    throw invalidParameterValue(`${holder} needs ZipFile, the zip in base64, or S3Bucket and S3Key, where it is.`);
  }
  if (zip !== undefined && (bucket !== undefined || key !== undefined)) throw invalidParameterValue(`${holder} holds ZipFile, or S3Bucket and S3Key: not both.`);
  if (zip !== undefined) {
    if (typeof zip !== 'string' || zip.length % 4 !== 0 || !BASE64.test(zip)) throw invalidParameterValue(`${prefix}ZipFile must be the zip in base64.`);
    return { zip: Buffer.from(zip, 'base64') };
  }
  if (typeof bucket !== 'string' || bucket === '' || typeof key !== 'string' || key === '') {
    throw invalidParameterValue(`${holder} needs S3Bucket and S3Key: the account's bucket where the zip is, and its key.`);
  }
  return { bucket, key };
}

/** The settings CreateFunction and UpdateFunctionConfiguration both take, as FF names them: those sent, checked. */
interface Settings {
  runtime?: Runtime;
  role?: string;
  handler?: string;
  description?: string;
  memory?: number;
  timeout?: number;
  /** All the variables, those sent replacing them all: none sent, none kept. */
  variables?: Record<string, string>;
}

/** Role, as Lambda's model checks it. */
function roleOf(role: unknown): string {
  if (typeof role !== 'string' || role.length > ROLE_MAX || !IAM_ROLE.test(role)) {
    throw invalidParameterValue("Role must be an IAM role's ARN, arn:aws:iam::<account>:role/<name>: FF keeps it, with no effect, as FF has no IAM.");
  }
  return role;
}

/** The settings sent, each checked; sizes within the plan unless they are the function's `current` ones. */
function settingsOf(input: Record<string, unknown>, plan: PlanView, current?: Pick<Function, 'memory' | 'timeout'>): Settings {
  const settings: Settings = {};
  if (input.Runtime !== undefined) {
    settings.runtime = RUNTIME_NAMED.get(said(input.Runtime));
    if (settings.runtime === undefined) throw invalidParameterValue(`The runtime ${said(input.Runtime)} isn't FF's: FF runs ${RUNTIMES}.`);
  }
  if (input.Role !== undefined) settings.role = roleOf(input.Role);
  const handler = input.Handler;
  if (handler !== undefined) {
    if (typeof handler !== 'string') throw invalidParameterValue('Handler must be a string: <file>.<function>, as index.handler.');
    const problem = handlerSyntaxProblem(handler);
    if (problem) throw invalidParameterValue(problem);
    settings.handler = handler;
  }
  const description = input.Description;
  if (description !== undefined) {
    if (typeof description !== 'string' || description.length > DESCRIPTION_MAX) throw invalidParameterValue(`Description must be a string of ${DESCRIPTION_MAX} characters at most.`);
    settings.description = description;
  }
  const { limits, name } = plan;
  settings.memory = wholeNumber(input, 'MemorySize', 'MB', [128, PLATFORM_LIMITS.memoryMb], { limit: limits.memoryMb, name }, current?.memory);
  settings.timeout = wholeNumber(input, 'Timeout', 'seconds', [1, PLATFORM_LIMITS.timeoutSeconds], { limit: limits.timeoutSeconds, name }, current?.timeout);
  const environment = input.Environment;
  if (environment !== undefined) {
    if (!(isObject(environment) && Object.keys(environment).every((key) => key === 'Variables'))) {
      throw invalidParameterValue('Environment must be an object with Variables, the variables by name.');
    }
    const variables = environment.Variables ?? {};
    const problems = environmentProblems(variables);
    if (problems.length > 0) throw invalidParameterValue(problems.join('; '));
    settings.variables = variables as Record<string, string>;
  }
  return settings;
}

/** Publish, DryRun: true or false. */
function flag(input: Record<string, unknown>, field: string): boolean {
  const sent = input[field];
  if (sent !== undefined && typeof sent !== 'boolean') throw invalidParameterValue(`${field} must be true or false.`);
  return sent === true;
}

/** RevisionId, which a change names to be refused once another came since the caller read it. */
function revisionIdOf(input: Record<string, unknown>): string | undefined {
  const sent = input.RevisionId;
  if (sent !== undefined && typeof sent !== 'string') throw invalidParameterValue('RevisionId must be the one that GetFunction answered.');
  return sent;
}

/**
 * CreateFunction's request, checked as Lambda checks it (ADR 0014, 2): each
 * field kept, mapped onto FF's, or refused saying why. The name is the one the
 * front door found in FunctionName, without a version or an alias, in the
 * key's account and region.
 */
export function createFunctionRequest(input: Record<string, unknown>, caller: Pick<LambdaCaller, 'accountId' | 'region' | 'plan'>): CreateFunctionRequest {
  const sentName = said(input.FunctionName);
  const named = parseFunctionName(sentName);
  if (!named) throw invalidParameterValue(`FunctionName must be a function's name, its ARN or its partial ARN, not ${sentName}.`);
  if (named.qualifier !== undefined) throw invalidParameterValue(`FunctionName names the function to create, without a version or an alias: not ${sentName}.`);
  if ((named.accountId !== undefined && named.accountId !== caller.accountId) || (named.region !== undefined && named.region !== caller.region)) {
    throw invalidParameterValue(`A key creates functions in its own account, ${caller.accountId}, in ${caller.region}: not ${sentName}.`);
  }
  const { name } = named;
  refuseOtherSettings(input, name, 'CreateFunction');

  if (input.Runtime === undefined) throw invalidParameterValue(`Runtime is required for a .zip package: ${RUNTIMES}.`);
  const role = roleOf(input.Role);
  if (input.Handler === undefined) throw invalidParameterValue('Handler is required for a .zip package: <file>.<function>, as index.handler.');
  const settings = settingsOf(input, caller.plan);
  const publish = flag(input, 'Publish');
  let tags: Record<string, string> | undefined;
  if (input.Tags !== undefined && !(isObject(input.Tags) && Object.keys(input.Tags).length === 0)) {
    tags = tagsOf(input.Tags);
    const problem = tagsProblem({}, tags);
    if (problem) throw invalidParameterValue(problem);
  }
  if (!isObject(input.Code)) throw invalidParameterValue('Code is required: ZipFile, the zip in base64, or S3Bucket and S3Key, where it is.');
  const other = Object.keys(input.Code).find((field) => !['ZipFile', 'S3Bucket', 'S3Key', 'ImageUri', 'S3ObjectVersion', 'SourceKMSKeyArn'].includes(field));
  if (other !== undefined) throw invalidParameterValue(`FF doesn't take Code.${other}.`);
  const variables = settings.variables && Object.keys(settings.variables).length > 0 ? settings.variables : undefined;
  return {
    fields: {
      name,
      runtime: settings.runtime as Runtime,
      handler: settings.handler,
      memory: settings.memory ?? DEFAULT_MEMORY_MB,
      timeout: settings.timeout ?? DEFAULT_TIMEOUT_SECONDS,
      ...(variables ? { environment: variables } : {}),
    },
    code: codeSourceOf(input.Code, 'Code', 'Code.'),
    description: settings.description ?? '',
    role,
    ...(tags ? { tags } : {}),
    publish,
  };
}

/**
 * UpdateFunctionConfiguration's request, checked as CreateFunction's is, each
 * field optional: what it sends changes, Environment's variables replacing them
 * all; sizes within the plan unless they are the function's own.
 */
export function updateConfigurationRequest(input: Record<string, unknown>, caller: Pick<LambdaCaller, 'plan'>, function_: Pick<Function, 'name' | 'memory' | 'timeout'>): ConfigurationChange {
  refuseOtherSettings(input, function_.name, 'UpdateFunctionConfiguration');
  const { runtime, role, handler, description, memory, timeout, variables } = settingsOf(input, caller.plan, function_);
  return {
    fields: defined({ runtime, handler, memory, timeout, environment: variables }),
    lambda: defined({ description, role, revisionId: revisionIdOf(input) }),
  };
}

/** UpdateFunctionCode's request, checked: its code, sent or in a bucket, as CreateFunction's is. */
export function updateCodeRequest(input: Record<string, unknown>): CodeChange {
  refuseUnknown(input, 'UpdateFunctionCode');
  refuseArchitectures(input.Architectures);
  const revisionId = revisionIdOf(input);
  return {
    code: codeSourceOf(input, 'UpdateFunctionCode', ''),
    publish: flag(input, 'Publish'),
    dryRun: flag(input, 'DryRun'),
    ...(revisionId === undefined ? {} : { revisionId }),
  };
}
