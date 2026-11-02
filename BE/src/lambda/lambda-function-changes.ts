import { HttpException, Injectable, Logger, ValidationPipe } from '@nestjs/common';
import { Readable } from 'node:stream';
import { EntityManager } from 'typeorm';
import { describeError } from '../common/describe-error';
import { NoNulPipe } from '../common/no-nul.pipe';
import { DTO_VALIDATION } from '../common/validation';
import { parseFunctionName } from '../functions/arns';
import { handlerSyntaxProblem } from '../functions/code-package';
import { CreateFunctionDto } from '../functions/dto/create-function.dto';
import { Runtime } from '../functions/entities/function.entity';
import { environmentProblems } from '../functions/environment';
import { FunctionsService, StartedCreate } from '../functions/functions.service';
import { FunctionVersionsService } from '../functions/versions.service';
import { PLATFORM_LIMITS } from '../plans/plan-limits';
import { PackagesService } from '../packages/packages.service';
import { reachesBucket } from '../storage/key-reach';
import { StorageDirectory } from '../storage/storage-directory.service';
import { StoreBuckets } from '../storage/store-buckets';
import { ResourceTagsService } from '../tags/resource-tags.service';
import { tagsProblem } from '../tags/tag-rules';
import { invalidParameterValue, resourceConflict } from './lambda-error';
import { LAMBDA_RUNTIMES, latestConfiguration } from './lambda-functions';
import { LambdaAnswer, LambdaCall, LambdaCaller, LambdaHandler, LambdaHandlers, namedFunction } from './lambda-operations';
import { tagsOf } from './lambda-tags';

/** FF's runtime by Lambda's name for it. */
const RUNTIME_NAMED = new Map<string, Runtime>(Object.entries(LAMBDA_RUNTIMES).map(([runtime, name]) => [name, runtime as Runtime]));

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

/** The fields CreateFunction takes, those above besides. */
const TAKEN = new Set([
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
  'TracingConfig',
  'Architectures',
  'EphemeralStorage',
  'SnapStart',
  'LoggingConfig',
  ...Object.keys(REFUSED),
]);

/** What CreateFunction asks for, checked, in FF's terms. */
export interface CreateFunctionRequest {
  /** FF's create but its code, which comes as a package once the zip is stored. */
  fields: Omit<CreateFunctionDto, 'code' | 'codeSha256'>;
  code: { zip: Buffer } | { bucket: string; key: string };
  description: string;
  role: string;
  tags?: Record<string, string>;
  publish: boolean;
}

/** A value as a refusal shows it: a string as sent, anything else as JSON. */
const said = (value: unknown): string => (typeof value === 'string' ? value : JSON.stringify(value));

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Sent with nothing in it: absent, null, false, empty, or an object of such, as the tools send a setting left at its default. */
const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || value === false || value === '' || (Array.isArray(value) && value.length === 0) || (isObject(value) && Object.values(value).every(isEmpty));

/** A whole number from `min` to `max`, Lambda's bounds; `fallback` when not sent; the plan's bound said apart. */
function wholeNumber(input: Record<string, unknown>, field: string, unit: string, [min, max]: [number, number], fallback: number, plan: { limit: number; name: string }): number {
  const sent = input[field];
  if (sent === undefined) return fallback;
  if (typeof sent !== 'number' || !Number.isInteger(sent) || sent < min || sent > max) {
    throw invalidParameterValue(`${field} must be a whole number of ${unit} from ${min} to ${max}, not ${JSON.stringify(sent)}.`);
  }
  if (sent > plan.limit) throw invalidParameterValue(`${field} must be at most ${plan.limit} ${unit} on the ${plan.name} plan.`);
  return sent;
}

/** The settings FF has one value of: sent as that value, or not at all. */
function refuseOtherSettings(input: Record<string, unknown>, name: string): void {
  if (input.PackageType !== undefined && input.PackageType !== 'Zip') throw invalidParameterValue(`${IMAGES} PackageType must be Zip.`);
  const architectures = input.Architectures;
  if (architectures !== undefined && !(Array.isArray(architectures) && architectures.every((architecture) => architecture === 'x86_64'))) {
    throw invalidParameterValue('FF runs x86_64 alone: Architectures must be [x86_64].');
  }
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
    if (!isEmpty(input[field])) throw invalidParameterValue(`${why} Send CreateFunction without ${field}.`);
  }
  const unknown = Object.keys(input).find((field) => !TAKEN.has(field));
  if (unknown !== undefined) throw invalidParameterValue(`FF doesn't take ${unknown} in CreateFunction.`);
}

/** Code: a zip in base64, or where one is, in a bucket of the account; never an image, an object's version, or a KMS key. */
function codeOf(sent: unknown): CreateFunctionRequest['code'] {
  if (!isObject(sent)) throw invalidParameterValue('Code is required: ZipFile, the zip in base64, or S3Bucket and S3Key, where it is.');
  if (sent.ImageUri !== undefined) throw invalidParameterValue(`${IMAGES} Send Code.ZipFile, or Code.S3Bucket and S3Key.`);
  if (sent.S3ObjectVersion !== undefined) throw invalidParameterValue("FF's buckets keep no object versions: send Code without S3ObjectVersion.");
  if (sent.SourceKMSKeyArn !== undefined) throw invalidParameterValue(`${KMS} Send Code without SourceKMSKeyArn.`);
  const other = Object.keys(sent).find((field) => !['ZipFile', 'S3Bucket', 'S3Key'].includes(field));
  if (other !== undefined) throw invalidParameterValue(`FF doesn't take Code.${other}.`);
  const { ZipFile: zip, S3Bucket: bucket, S3Key: key } = sent;
  if (zip !== undefined && (bucket !== undefined || key !== undefined)) throw invalidParameterValue('Code holds ZipFile, or S3Bucket and S3Key: not both.');
  if (zip !== undefined) {
    if (typeof zip !== 'string' || zip.length % 4 !== 0 || !BASE64.test(zip)) throw invalidParameterValue('Code.ZipFile must be the zip in base64.');
    return { zip: Buffer.from(zip, 'base64') };
  }
  if (typeof bucket !== 'string' || bucket === '' || typeof key !== 'string' || key === '') {
    throw invalidParameterValue("Code needs S3Bucket and S3Key: the account's bucket where the zip is, and its key.");
  }
  return { bucket, key };
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
  refuseOtherSettings(input, name);

  const runtimes = [...RUNTIME_NAMED.keys()].join(' or ');
  if (input.Runtime === undefined) throw invalidParameterValue(`Runtime is required for a .zip package: ${runtimes}.`);
  const runtime = RUNTIME_NAMED.get(said(input.Runtime));
  if (runtime === undefined) throw invalidParameterValue(`The runtime ${said(input.Runtime)} isn't FF's: FF runs ${runtimes}.`);
  const role = input.Role;
  if (typeof role !== 'string' || role.length > ROLE_MAX || !IAM_ROLE.test(role)) {
    throw invalidParameterValue("Role must be an IAM role's ARN, arn:aws:iam::<account>:role/<name>: FF keeps it, with no effect, as FF has no IAM.");
  }
  const handler = input.Handler;
  if (handler === undefined) throw invalidParameterValue('Handler is required for a .zip package: <file>.<function>, as index.handler.');
  if (typeof handler !== 'string') throw invalidParameterValue('Handler must be a string: <file>.<function>, as index.handler.');
  const handlerProblem = handlerSyntaxProblem(handler);
  if (handlerProblem) throw invalidParameterValue(handlerProblem);
  const description = input.Description ?? '';
  if (typeof description !== 'string' || description.length > DESCRIPTION_MAX) throw invalidParameterValue(`Description must be a string of ${DESCRIPTION_MAX} characters at most.`);
  if (input.Publish !== undefined && typeof input.Publish !== 'boolean') throw invalidParameterValue('Publish must be true or false.');
  const { limits, name: planName } = caller.plan;
  const memory = wholeNumber(input, 'MemorySize', 'MB', [128, PLATFORM_LIMITS.memoryMb], DEFAULT_MEMORY_MB, { limit: limits.memoryMb, name: planName });
  const timeout = wholeNumber(input, 'Timeout', 'seconds', [1, PLATFORM_LIMITS.timeoutSeconds], DEFAULT_TIMEOUT_SECONDS, { limit: limits.timeoutSeconds, name: planName });

  const environment = input.Environment;
  if (environment !== undefined && !(isObject(environment) && Object.keys(environment).every((key) => key === 'Variables'))) {
    throw invalidParameterValue('Environment must be an object with Variables, the variables by name.');
  }
  const variables = isObject(environment) ? environment.Variables : undefined;
  if (variables !== undefined) {
    const problems = environmentProblems(variables);
    if (problems.length > 0) throw invalidParameterValue(problems.join('; '));
  }
  let tags: Record<string, string> | undefined;
  if (input.Tags !== undefined && !(isObject(input.Tags) && Object.keys(input.Tags).length === 0)) {
    tags = tagsOf(input.Tags);
    const problem = tagsProblem({}, tags);
    if (problem) throw invalidParameterValue(problem);
  }
  return {
    fields: { name, runtime, handler, memory, timeout, ...(variables === undefined ? {} : { environment: variables as Record<string, string> }) },
    code: codeOf(input.Code),
    description,
    role,
    ...(tags ? { tags } : {}),
    publish: input.Publish === true,
  };
}

/** S3's refusal of a read of the code, as Lambda passes it on. */
const s3Refusal = (code: string, message: string) => invalidParameterValue(`Error occurred while GetObject. S3 Error Code: ${code}. S3 Error Message: ${message}`);

/**
 * Lambda's changes of functions over FF's (ADR 0014, 2): CreateFunction,
 * which answers at once, the function Pending while it rolls out, then
 * Active, or Failed with FF's diagnosis; and DeleteFunction, of a function or
 * of one of its versions.
 */
@Injectable()
export class LambdaFunctionChanges implements LambdaHandlers {
  private readonly logger = new Logger(LambdaFunctionChanges.name);
  private readonly validation = new ValidationPipe(DTO_VALIDATION);
  private readonly noNul = new NoNulPipe();

  constructor(
    private readonly functions: FunctionsService,
    private readonly versions: FunctionVersionsService,
    private readonly packages: PackagesService,
    private readonly tags: ResourceTagsService,
    private readonly directory: StorageDirectory,
    private readonly store: StoreBuckets,
  ) {}

  readonly handlers: Record<string, LambdaHandler> = {
    CreateFunction: (call, caller) => this.createFunction(call, caller),
    DeleteFunction: (call, caller) => this.deleteFunction(call, caller),
  };

  private async createFunction({ input }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    this.noNul.transform(input, { type: 'body' });
    const request = createFunctionRequest(input, caller);
    // Before the code is stored: a name taken is refused at once, as Lambda's.
    if ((await this.functions.findAll(caller.accountId, request.fields.name)).length > 0) throw resourceConflict(`Function already exist: ${request.fields.name}`);
    const code = await this.codeStream(request.code, caller);
    const { package: stored } = await this.packages.upload(caller.accountId, code.body, 'application/zip', code.length);
    const dto = (await this.validation.transform({ ...request.fields, codeSha256: stored.codeSha256 }, { type: 'body', metatype: CreateFunctionDto })) as CreateFunctionDto;
    const started = await this.functions.startCreate(caller.accountId, dto, { description: request.description, role: request.role });
    if (request.tags) await this.tags.tagFunction(caller.accountId, started.function_.id, request.tags);
    this.rollOut(started, caller.accountId, request.publish);
    return { status: 201, document: latestConfiguration(started.function_, caller.region, started.environment.variables) };
  }

  /** The zip's bytes: sent, or read from the account's bucket that the key reaches, as Lambda reads it with its caller's rights. */
  private async codeStream(code: CreateFunctionRequest['code'], caller: LambdaCaller): Promise<{ body: Readable; length?: number }> {
    if ('zip' in code) return { body: Readable.from([code.zip]), length: code.zip.length };
    // Another account's bucket is one that doesn't exist, as S3 says of a bucket the key can't know of.
    const bucket = await this.directory.bucket(code.bucket);
    if (!bucket || bucket.accountId !== caller.accountId) throw s3Refusal('NoSuchBucket', 'The specified bucket does not exist');
    const account = await this.directory.account(caller.accountId);
    if (account?.storageDisabledAt) throw s3Refusal('AccessDenied', `FF turned the account's buckets off: ${account.storageDisabledReason}`);
    if (!reachesBucket(caller.key, bucket.name)) throw s3Refusal('AccessDenied', `The access key doesn't reach the bucket ${bucket.name}.`);
    const object = await this.store.object(bucket.storeName, code.key);
    if (!object) throw s3Refusal('NoSuchKey', 'The specified key does not exist.');
    return object;
  }

  /**
   * The create's rollout, which the answer doesn't wait for: the function is
   * Active once it ends well, with its first version if Publish said so, in
   * the same transaction; else Failed, its reason in its record.
   */
  private rollOut(started: StartedCreate, accountId: string, publish: boolean): void {
    const { id } = started.function_;
    const whenActive = publish ? (manager: EntityManager) => this.versions.publishIn(manager, accountId, id, {}) : undefined;
    started
      .rollOut(whenActive)
      .then(() => (publish ? this.versions.labelLatest(accountId, id) : undefined))
      .catch((error: unknown) => {
        // A failed deploy is in the function's record, and a platform's failure in the log already: anything else is new.
        if (!(error instanceof HttpException)) this.logger.error(`The rollout of function ${id} failed: ${describeError(error)}`, error instanceof Error ? error.stack : undefined);
      });
  }

  /** The function, its versions with it; or one version, by its number; never $LATEST alone, nor an alias, which DeleteAlias deletes. */
  private async deleteFunction({ query, groups }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = namedFunction(caller);
    // The front door reads $LATEST as no qualifier, which here would delete the function.
    if (query.get('Qualifier') === '$LATEST' || groups[0].endsWith(':$LATEST')) {
      throw invalidParameterValue('$LATEST goes with its function: send DeleteFunction without a qualifier to delete the function.');
    }
    const qualifier = caller.named?.qualifier;
    if (qualifier === undefined) {
      await this.functions.remove(caller.accountId, function_.id);
    } else if (/^[1-9]\d*$/.test(qualifier)) {
      await this.versions.remove(caller.accountId, function_.id, Number(qualifier));
    } else {
      throw invalidParameterValue(`DeleteFunction deletes a function or one of its versions, not the alias ${qualifier}: DeleteAlias deletes it.`);
    }
    return { status: 204 };
  }
}
