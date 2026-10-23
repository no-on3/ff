import type { EventInvokeConfig } from '../services/api';

/** Lambda's defaults for a function's calls that don't wait: two retries after a failure, each call kept 6 hours. */
export const DEFAULT_RETRIES = 2;
export const DEFAULT_KEPT_MINUTES = 360;
/** The API's bounds: 60 seconds to 6 hours, which the form says in minutes. */
export const KEPT_MINUTES = { min: 1, max: 360 } as const;

/** The form for a function's settings: its retries, how long a call is kept, and its destinations by name, '' for none. */
export interface AsyncSettingsForm {
  retries: number;
  keptMinutes: string;
  onSuccess: string;
  onFailure: string;
}

/** The function name a Lambda ARN ends with: arn:aws:lambda:<region>:<account>:function:<name>, $LATEST or not. */
export const nameOfArn = (arn: string | undefined): string => (arn ? (/:function:([^:]+)/.exec(arn)?.[1] ?? arn) : '');

/** The form for the settings there are, or for Lambda's defaults when there are none. */
export function asyncSettingsForm(config: EventInvokeConfig | null): AsyncSettingsForm {
  return {
    retries: config?.maximumRetryAttempts ?? DEFAULT_RETRIES,
    keptMinutes: String(Math.round((config?.maximumEventAgeInSeconds ?? DEFAULT_KEPT_MINUTES * 60) / 60)),
    onSuccess: nameOfArn(config?.destinationConfig.onSuccess.destination),
    onFailure: nameOfArn(config?.destinationConfig.onFailure.destination),
  };
}

/** The body of PUT /functions/:id/event-invoke-config, the destinations by their functions' names, which the API takes as their ARNs; or what is wrong in the form. */
export function asyncSettingsBody(form: AsyncSettingsForm): { body: Record<string, unknown> } | { problem: string } {
  const minutes = Number(form.keptMinutes);
  if (!Number.isInteger(minutes) || minutes < KEPT_MINUTES.min || minutes > KEPT_MINUTES.max) {
    return { problem: `A call is kept from ${KEPT_MINUTES.min} minute to ${KEPT_MINUTES.max} minutes (6 hours), in whole minutes` };
  }
  const destinationConfig: Record<string, { destination: string }> = {};
  if (form.onSuccess) destinationConfig.onSuccess = { destination: form.onSuccess };
  if (form.onFailure) destinationConfig.onFailure = { destination: form.onFailure };
  return {
    body: {
      maximumRetryAttempts: form.retries,
      maximumEventAgeInSeconds: minutes * 60,
      ...(Object.keys(destinationConfig).length > 0 ? { destinationConfig } : {}),
    },
  };
}

/** How long a call is kept, in words: hours when it is whole hours, else minutes. */
export function keptText(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? '1 hour' : `${seconds / 3600} hours`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

const retriesText = (retries: number) => (retries === 0 ? 'not retried' : retries === 1 ? 'retried once' : 'retried twice');

/** The settings in one sentence, as the panel says them. */
export function asyncSettingsText(config: EventInvokeConfig | null): string {
  const retries = config?.maximumRetryAttempts ?? DEFAULT_RETRIES;
  const kept = keptText(config?.maximumEventAgeInSeconds ?? DEFAULT_KEPT_MINUTES * 60);
  const destinations = [
    config?.destinationConfig.onSuccess.destination && `a call that succeeds goes on to ${nameOfArn(config.destinationConfig.onSuccess.destination)}`,
    config?.destinationConfig.onFailure.destination && `one that fails for good to ${nameOfArn(config.destinationConfig.onFailure.destination)}`,
  ].filter(Boolean);
  const sentence = `A call that fails is ${retriesText(retries)}, and kept ${kept} at most`;
  const ending = destinations.length ? `; ${destinations.join(', ')}.` : ', going nowhere once it ends.';
  return config ? `${sentence}${ending}` : `AWS Lambda's defaults: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}${ending}`;
}
