import { Injectable, NotFoundException, ValidationPipe } from '@nestjs/common';
import { DTO_VALIDATION } from '../common/validation';
import { EventInvokeConfigView, PutEventInvokeConfigDto } from '../functions/dto/event-invoke-config.dto';
import { Function } from '../functions/entities/function.entity';
import { EventInvokeConfigService } from '../functions/event-invoke-config.service';
import { invalidParameterValue, resourceNotFound } from './lambda-error';
import { isObject, refuseUnknownFields } from './lambda-fields';
import { LambdaAnswer, LambdaCall, LambdaCaller, LambdaHandler, LambdaHandlers, namedFunction, ok, unqualifiedFunction } from './lambda-operations';
import { pageOf } from './lambda-pages';

/** The settings Lambda's EventInvokeConfig takes, besides the function its path names. */
const SETTINGS = ['MaximumRetryAttempts', 'MaximumEventAgeInSeconds', 'DestinationConfig'] as const;
const TAKEN = new Set<string>(SETTINGS);

/** Lambda's limit on ListFunctionEventInvokeConfigs' MaxItems. */
const LIST_MOST = 50;

type Destinations = { onSuccess?: { destination: string }; onFailure?: { destination: string } };

/** A function's settings for its asynchronous calls, as Lambda's FunctionEventInvokeConfig: those left at Lambda's default left out, LastModified in seconds. */
export function eventInvokeConfiguration(view: EventInvokeConfigView): Record<string, unknown> {
  const destination = (to: { destination?: string }) => (to.destination ? { Destination: to.destination } : {});
  return {
    LastModified: new Date(view.lastModified).getTime() / 1000,
    FunctionArn: view.functionArn,
    ...(view.maximumRetryAttempts !== null ? { MaximumRetryAttempts: view.maximumRetryAttempts } : {}),
    ...(view.maximumEventAgeInSeconds !== null ? { MaximumEventAgeInSeconds: view.maximumEventAgeInSeconds } : {}),
    DestinationConfig: { OnSuccess: destination(view.destinationConfig.onSuccess), OnFailure: destination(view.destinationConfig.onFailure) },
  };
}

/** Lambda's DestinationConfig as FF's: OnSuccess and OnFailure, each with its Destination alone. */
function destinationsOf(sent: unknown): Destinations {
  if (sent === null) return {};
  if (!isObject(sent)) throw invalidParameterValue('DestinationConfig must be an object of OnSuccess and OnFailure.');
  const destinations: Destinations = {};
  for (const [field, value] of Object.entries(sent)) {
    if (field !== 'OnSuccess' && field !== 'OnFailure') throw invalidParameterValue(`DestinationConfig takes OnSuccess and OnFailure, not ${field}.`);
    if (value === null || (isObject(value) && Object.keys(value).length === 0)) continue;
    if (!isObject(value) || Object.keys(value).some((key) => key !== 'Destination') || typeof value.Destination !== 'string') {
      throw invalidParameterValue(`DestinationConfig.${field} takes Destination alone, an ARN.`);
    }
    destinations[field === 'OnSuccess' ? 'onSuccess' : 'onFailure'] = { destination: value.Destination };
  }
  return destinations;
}

/**
 * Lambda's settings for a function's asynchronous calls over FF's (ADR 0010): PutFunctionEventInvokeConfig,
 * UpdateFunctionEventInvokeConfig, GetFunctionEventInvokeConfig, DeleteFunctionEventInvokeConfig and
 * ListFunctionEventInvokeConfigs. FF keeps one for the function, which its versions and aliases follow too, where
 * Lambda keeps one for each: $LATEST's, the function named alone, is the one there is; a version's or an alias's
 * is refused, saying so.
 */
@Injectable()
export class LambdaAsyncSettings implements LambdaHandlers {
  private readonly validation = new ValidationPipe(DTO_VALIDATION);

  constructor(private readonly configs: EventInvokeConfigService) {}

  readonly handlers: Record<string, LambdaHandler> = {
    PutFunctionEventInvokeConfig: (call, caller) => this.put(call, caller),
    UpdateFunctionEventInvokeConfig: (call, caller) => this.update(call, caller),
    GetFunctionEventInvokeConfig: async (call, caller) => {
      const function_ = this.functionOf(call, caller);
      return ok(eventInvokeConfiguration(await this.withConfig(function_, () => this.configs.get(caller.accountId, function_.id))));
    },
    DeleteFunctionEventInvokeConfig: async (call, caller) => {
      const function_ = this.functionOf(call, caller);
      await this.withConfig(function_, () => this.configs.remove(caller.accountId, function_.id));
      return { status: 204 };
    },
    ListFunctionEventInvokeConfigs: (call, caller) => this.list(call, caller),
  };

  /** The settings replaced whole, as Lambda's: what the request leaves out goes back to Lambda's default. */
  private async put(call: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = this.functionOf(call, caller);
    refuseUnknownFields(call.input, call.operation.name, TAKEN);
    const dto = await this.dtoOf(call.input);
    return ok(eventInvokeConfiguration(await this.configs.put(caller.accountId, function_.id, dto)));
  }

  /** What the request sends replaces its own setting, the rest stays; a function without settings has none to change, as on Lambda. */
  private async update(call: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = this.functionOf(call, caller);
    refuseUnknownFields(call.input, call.operation.name, TAKEN);
    const current = await this.withConfig(function_, () => this.configs.get(caller.accountId, function_.id));
    const kept = eventInvokeConfiguration(current);
    const merged = Object.fromEntries(SETTINGS.map((field) => [field, call.input[field] !== undefined ? call.input[field] : kept[field]]));
    const dto = await this.dtoOf(merged);
    return ok(eventInvokeConfiguration(await this.configs.put(caller.accountId, function_.id, dto)));
  }

  /** The function's settings, the one entry there is, or none; named without a version or an alias. */
  private async list({ query, operation }: LambdaCall, caller: LambdaCaller): Promise<LambdaAnswer> {
    const function_ = unqualifiedFunction(caller, operation.name);
    let configs: EventInvokeConfigView[] = [];
    try {
      configs = [await this.configs.get(caller.accountId, function_.id)];
    } catch (error) {
      if (!(error instanceof NotFoundException)) throw error;
    }
    const { page, nextMarker } = pageOf(query, configs, (config) => [config.functionArn], operation.name, { most: LIST_MOST });
    return ok({ FunctionEventInvokeConfigs: page.map(eventInvokeConfiguration), ...(nextMarker !== undefined ? { NextMarker: nextMarker } : {}) });
  }

  /** The function the path names, alone or as $LATEST: FF's settings are the function's, and its versions' and aliases' with it. */
  private functionOf({ operation }: LambdaCall, caller: LambdaCaller): Function {
    const function_ = namedFunction(caller);
    const qualifier = caller.named?.qualifier;
    if (qualifier !== undefined) {
      throw invalidParameterValue(
        `FF keeps one setting of a function's asynchronous calls, which its versions and aliases follow too: ${operation.name} names ${function_.name} alone, or $LATEST, not ${qualifier}.`,
      );
    }
    return function_;
  }

  /** Lambda's fields as FF's DTO, checked by FF's own checks. */
  private async dtoOf(input: Record<string, unknown>): Promise<PutEventInvokeConfigDto> {
    const sent = {
      ...(input.MaximumRetryAttempts !== undefined && input.MaximumRetryAttempts !== null ? { maximumRetryAttempts: input.MaximumRetryAttempts } : {}),
      ...(input.MaximumEventAgeInSeconds !== undefined && input.MaximumEventAgeInSeconds !== null ? { maximumEventAgeInSeconds: input.MaximumEventAgeInSeconds } : {}),
      ...(input.DestinationConfig !== undefined ? { destinationConfig: destinationsOf(input.DestinationConfig) } : {}),
    };
    return (await this.validation.transform(sent, { type: 'body', metatype: PutEventInvokeConfigDto })) as PutEventInvokeConfigDto;
  }

  /** What FF's service answers; a function without settings, in Lambda's words, by its $LATEST's ARN. */
  private async withConfig<T>(function_: Function, act: () => Promise<T>): Promise<T> {
    try {
      return await act();
    } catch (error) {
      if (error instanceof NotFoundException) throw resourceNotFound(`The function ${this.configs.arnOf(function_)}:$LATEST doesn't have an EventInvokeConfig`);
      throw error;
    }
  }
}
