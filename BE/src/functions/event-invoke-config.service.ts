import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { functionArn, parseFunctionArn } from './arns';
import { LAMBDA_RETRY_POLICY, RetryPolicy } from './async-invoke';
import { EventInvokeConfigView, PutEventInvokeConfigDto } from './dto/event-invoke-config.dto';
import { FunctionEventInvokeConfig } from './entities/function-event-invoke-config.entity';
import { Function } from './entities/function.entity';
import { FunctionsService } from './functions.service';

/** What the worker follows for a function's asynchronous calls: its retries and maximum age, and its destinations' ARNs. */
export interface AsyncSettings {
  policy: RetryPolicy;
  onSuccess: string | null;
  onFailure: string | null;
}

/**
 * A function's settings for its asynchronous calls, as AWS Lambda's
 * EventInvokeConfig (ADR 0010): put whole, read, deleted, each change in the
 * audit log. A destination is another function of the account, in FF's
 * region, named by its ARN, which must exist when it is set; a function gone
 * since is a record not delivered, as Lambda's DestinationDeliveryFailures.
 */
@Injectable()
export class EventInvokeConfigService {
  private readonly region: string;

  constructor(
    @InjectRepository(FunctionEventInvokeConfig) private readonly configs: Repository<FunctionEventInvokeConfig>,
    private readonly functions: FunctionsService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.region = config.getOrThrow<string>('schedules.region');
  }

  /** The function's ARN, as Lambda's: in FF's region, under its account and name. */
  arnOf(fn: Pick<Function, 'accountId' | 'name'>): string {
    return functionArn(this.region, fn.accountId, fn.name);
  }

  async get(accountId: string, id: string): Promise<EventInvokeConfigView> {
    const fn = await this.functions.findOne(accountId, id);
    const config = await this.configs.findOneBy({ functionId: id });
    if (!config) throw this.none(fn);
    return this.view(fn, config);
  }

  /** As Lambda's PutFunctionEventInvokeConfig: the settings replaced whole, what is left out back to Lambda's default. */
  async put(accountId: string, id: string, dto: PutEventInvokeConfigDto): Promise<EventInvokeConfigView> {
    const fn = await this.functions.findOne(accountId, id);
    const onSuccess = await this.destination(fn, 'onSuccess', dto.destinationConfig?.onSuccess?.destination);
    const onFailure = await this.destination(fn, 'onFailure', dto.destinationConfig?.onFailure?.destination);
    const saved = await this.configs.save({
      functionId: id,
      maximumRetryAttempts: dto.maximumRetryAttempts ?? null,
      maximumEventAgeInSeconds: dto.maximumEventAgeInSeconds ?? null,
      onSuccess,
      onFailure,
    });
    await this.audit.record({
      accountId,
      action: 'event_invoke_config.put',
      resource: `function:${id}`,
      details: { maximumRetryAttempts: saved.maximumRetryAttempts, maximumEventAgeInSeconds: saved.maximumEventAgeInSeconds, onSuccess, onFailure },
    });
    return this.view(fn, saved);
  }

  async remove(accountId: string, id: string): Promise<void> {
    const fn = await this.functions.findOne(accountId, id);
    const { affected } = await this.configs.delete({ functionId: id });
    if (!affected) throw this.none(fn);
    await this.audit.record({ accountId, action: 'event_invoke_config.delete', resource: `function:${id}` });
  }

  /** What the worker follows for the function's calls: its settings, else Lambda's defaults and no destination. */
  async settingsFor(functionId: string): Promise<AsyncSettings> {
    const config = await this.configs.findOneBy({ functionId });
    return {
      policy: {
        maximumRetryAttempts: config?.maximumRetryAttempts ?? LAMBDA_RETRY_POLICY.maximumRetryAttempts,
        maximumEventAgeSeconds: config?.maximumEventAgeInSeconds ?? LAMBDA_RETRY_POLICY.maximumEventAgeSeconds,
      },
      onSuccess: config?.onSuccess ?? null,
      onFailure: config?.onFailure ?? null,
    };
  }

  /** The account's function a destination's ARN names, if it is there still. */
  async destinationFunction(accountId: string, arn: string): Promise<Function | undefined> {
    const named = parseFunctionArn(arn);
    if (!named || named.accountId !== accountId) return undefined;
    const [fn] = await this.functions.findAll(accountId, named.name);
    return fn;
  }

  /** A destination's ARN, as kept: another function of the account, in FF's region, there now; null for none. */
  private async destination(fn: Function, which: 'onSuccess' | 'onFailure', arn: string | undefined): Promise<string | null> {
    if (arn === undefined) return null;
    const field = `destinationConfig.${which}.destination`;
    const named = parseFunctionArn(arn);
    if (!named) {
      if (arn.startsWith('arn:aws:sqs:')) {
        throw new BadRequestException(`${field}: a queue becomes a destination with FF's queues; for now, name another function of the account`);
      }
      throw new BadRequestException(`${field} must be the ARN of a function of the account, as Lambda's: ${this.arnOf({ accountId: fn.accountId, name: '<name>' })}`);
    }
    if (named.region !== this.region || named.accountId !== fn.accountId) {
      throw new BadRequestException(`${field} must be a function of this account, in ${this.region}: ${this.arnOf({ accountId: fn.accountId, name: named.name })}`);
    }
    if (named.name === fn.name) {
      throw new BadRequestException(`${field}: a function can't be its own destination, as each record would call it again`);
    }
    if (!(await this.destinationFunction(fn.accountId, arn))) throw new BadRequestException(`${field}: the account has no function named "${named.name}"`);
    return this.arnOf({ accountId: fn.accountId, name: named.name });
  }

  private none(fn: Function): NotFoundException {
    return new NotFoundException(
      `The function ${this.arnOf(fn)} has no event invoke configuration: its asynchronous calls are retried twice and kept 6 hours, AWS Lambda's defaults`,
    );
  }

  private view(fn: Function, config: FunctionEventInvokeConfig): EventInvokeConfigView {
    return {
      functionArn: `${this.arnOf(fn)}:$LATEST`,
      maximumRetryAttempts: config.maximumRetryAttempts,
      maximumEventAgeInSeconds: config.maximumEventAgeInSeconds,
      destinationConfig: {
        onSuccess: config.onSuccess ? { destination: config.onSuccess } : {},
        onFailure: config.onFailure ? { destination: config.onFailure } : {},
      },
      lastModified: config.updatedAt,
    };
  }
}
