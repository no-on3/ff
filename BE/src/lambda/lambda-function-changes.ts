import { HttpException, Injectable, Logger, ValidationPipe } from '@nestjs/common';
import { Readable } from 'node:stream';
import { EntityManager } from 'typeorm';
import { describeError } from '../common/describe-error';
import { NoNulPipe } from '../common/no-nul.pipe';
import { DTO_VALIDATION } from '../common/validation';
import { ChangeUnderWayException, revisionMoved } from '../functions/change-under-way';
import { CreateFunctionDto } from '../functions/dto/create-function.dto';
import { UpdateFunctionDto } from '../functions/dto/update-function.dto';
import { FunctionsService, StartedChange, WhenLive } from '../functions/functions.service';
import { FunctionVersionsService } from '../functions/versions.service';
import { PackagesService } from '../packages/packages.service';
import { reachesBucket } from '../storage/key-reach';
import { StorageDirectory } from '../storage/storage-directory.service';
import { StoreBuckets } from '../storage/store-buckets';
import { ResourceTagsService } from '../tags/resource-tags.service';
import { invalidParameterValue, resourceConflict } from './lambda-error';
import { CodeSource, createFunctionRequest, updateCodeRequest, updateConfigurationRequest } from './lambda-function-requests';
import { latestConfiguration } from './lambda-functions';
import { LambdaAnswer, LambdaCall, LambdaCaller, LambdaHandler, LambdaHandlers, namedFunction, ok } from './lambda-operations';

/** S3's refusal of a read of the code, as Lambda passes it on. */
const s3Refusal = (code: string, message: string) => invalidParameterValue(`Error occurred while GetObject. S3 Error Code: ${code}. S3 Error Message: ${message}`);

/**
 * Lambda's changes of functions over FF's (ADR 0014, 2), each answered at
 * once, its rollout after (ADR 0014, 6): CreateFunction, the function Pending,
 * then Active, or Failed with FF's diagnosis; UpdateFunctionConfiguration and
 * UpdateFunctionCode, its last update InProgress, then Successful, or Failed
 * with its reason, the previous version still live; and DeleteFunction, of a
 * function or of one of its versions. A change while another runs is refused,
 * as Lambda refuses it.
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
    UpdateFunctionConfiguration: (call, caller) => this.updateConfiguration(call, caller),
    UpdateFunctionCode: (call, caller) => this.updateCode(call, caller),
    DeleteFunction: (call, caller) => this.deleteFunction(call, caller),
  };

  private async createFunction({ input }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    this.noNul.transform(input, { type: 'body' });
    const request = createFunctionRequest(input, caller);
    // Before the code is stored: a name taken is refused at once, as Lambda's.
    if ((await this.functions.findAll(caller.accountId, request.fields.name)).length > 0) throw resourceConflict(`Function already exist: ${request.fields.name}`);
    const codeSha256 = await this.storedCode(request.code, caller);
    const dto = (await this.validation.transform({ ...request.fields, codeSha256 }, { type: 'body', metatype: CreateFunctionDto })) as CreateFunctionDto;
    const started = await this.functions.startCreate(caller.accountId, dto, { description: request.description, role: request.role });
    if (request.tags) await this.tags.tagFunction(caller.accountId, started.function_.id, request.tags);
    this.rollOut(started, caller.accountId, request.publish);
    return { status: 201, document: latestConfiguration(started.function_, caller.region, started.environment.variables) };
  }

  /** The settings sent change, the rest stays: answered InProgress when a new version rolls out. */
  private async updateConfiguration({ input }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    this.noNul.transform(input, { type: 'body' });
    const function_ = namedFunction(caller);
    const request = updateConfigurationRequest(input, caller, function_);
    const dto = (await this.validation.transform(request.fields, { type: 'body', metatype: UpdateFunctionDto })) as UpdateFunctionDto;
    return this.answer(await this.functions.startUpdate(caller.accountId, function_.id, dto, request.lambda), caller, false);
  }

  /**
   * New code, sent or in the account's bucket, stored as FF's packages are,
   * with a version once it is live when Publish says so; with DryRun, every
   * check made and nothing changed, the function answered as it is.
   */
  private async updateCode({ input }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    this.noNul.transform(input, { type: 'body' });
    const function_ = namedFunction(caller);
    const request = updateCodeRequest(input);
    // Before the code is read and stored: a change under way, or one that came since its caller read the function, is refused at once.
    if (this.functions.isChanging(function_)) throw new ChangeUnderWayException(function_);
    if (request.revisionId !== undefined && request.revisionId !== function_.revisionId) throw revisionMoved(request.revisionId, function_);
    if (request.dryRun) {
      (await this.codeStream(request.code, caller)).body.destroy();
      return ok(latestConfiguration(function_, caller.region, (await this.functions.describe(caller.accountId, function_.id)).environment));
    }
    const codeSha256 = await this.storedCode(request.code, caller);
    const dto = (await this.validation.transform({ codeSha256 }, { type: 'body', metatype: UpdateFunctionDto })) as UpdateFunctionDto;
    const started = await this.functions.startUpdate(caller.accountId, function_.id, dto, request.revisionId === undefined ? {} : { revisionId: request.revisionId });
    return this.answer(started, caller, request.publish);
  }

  /**
   * An update's answer: at once, its last update InProgress, while a new
   * version rolls out after it; once saved, Successful, when the change is of
   * the record alone (a description, a role).
   */
  private async answer(started: StartedChange, caller: LambdaCaller, publish: boolean): Promise<LambdaAnswer> {
    if (!started.rollsOut) {
      const saved = await started.rollOut(this.publishing(caller.accountId, started.function_.id, publish));
      if (publish) await this.versions.labelLatest(caller.accountId, saved.id);
      return ok(latestConfiguration(saved, caller.region, saved.environment));
    }
    this.rollOut(started, caller.accountId, publish);
    return ok(latestConfiguration(started.function_, caller.region, started.environment.variables));
  }

  /** The code's package, stored as FF's packages are; its SHA-256. */
  private async storedCode(code: CodeSource, caller: LambdaCaller): Promise<string> {
    const { body, length } = await this.codeStream(code, caller);
    const { package: stored } = await this.packages.upload(caller.accountId, body, 'application/zip', length);
    return stored.codeSha256;
  }

  /** The zip's bytes: sent, or read from the account's bucket that the key reaches, as Lambda reads it with its caller's rights. */
  private async codeStream(code: CodeSource, caller: LambdaCaller): Promise<{ body: Readable; length?: number }> {
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

  /** What a change does once live when Publish says so: a version, in the transaction that says the change is live. */
  private publishing(accountId: string, id: string, publish: boolean): WhenLive | undefined {
    return publish ? (manager: EntityManager) => this.versions.publishIn(manager, accountId, id, {}) : undefined;
  }

  /**
   * A change's rollout, which the answer doesn't wait for: live once it ends
   * well, with a version if Publish said so, in the same transaction; else
   * Failed, its reason in its record.
   */
  private rollOut(started: StartedChange, accountId: string, publish: boolean): void {
    const { id } = started.function_;
    started
      .rollOut(this.publishing(accountId, id, publish))
      .then(() => (publish ? this.versions.labelLatest(accountId, id) : undefined))
      .catch((error: unknown) => {
        // A failed rollout is in the function's record, and a platform's failure in the log already: anything else is new.
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
