import { describe, expect, it } from 'vitest';
import type { EventInvokeConfig } from '../services/api';
import { asyncSettingsBody, asyncSettingsForm, asyncSettingsText, keptText, nameOfArn } from './async-settings';

const ARN = 'arn:aws:lambda:tn-tunis-1:000000000001:function:failed-orders';
const config = (values: Partial<EventInvokeConfig> = {}): EventInvokeConfig => ({
  functionArn: 'arn:aws:lambda:tn-tunis-1:000000000001:function:orders:$LATEST',
  maximumRetryAttempts: null,
  maximumEventAgeInSeconds: null,
  destinationConfig: { onSuccess: {}, onFailure: {} },
  lastModified: '2026-10-23T10:00:00.000Z',
  ...values,
});

describe("a function's settings for its calls that don't wait", () => {
  it("say Lambda's defaults when there are none, and what is set when there are", () => {
    expect(asyncSettingsText(null)).toBe("AWS Lambda's defaults: a call that fails is retried twice, and kept 6 hours at most, going nowhere once it ends.");
    expect(asyncSettingsText(config({ maximumRetryAttempts: 0, maximumEventAgeInSeconds: 1800, destinationConfig: { onSuccess: {}, onFailure: { destination: ARN } } }))).toBe(
      'A call that fails is not retried, and kept 30 minutes at most; one that fails for good to failed-orders.',
    );
    expect(asyncSettingsText(config({ maximumRetryAttempts: 1, destinationConfig: { onSuccess: { destination: ARN }, onFailure: { destination: ARN } } }))).toBe(
      'A call that fails is retried once, and kept 6 hours at most; a call that succeeds goes on to failed-orders, one that fails for good to failed-orders.',
    );
  });

  it('fill the form, Lambda\'s defaults for what is not set, the destinations by name', () => {
    expect(asyncSettingsForm(null)).toEqual({ retries: 2, keptMinutes: '360', onSuccess: '', onFailure: '' });
    expect(asyncSettingsForm(config({ maximumRetryAttempts: 0, maximumEventAgeInSeconds: 120, destinationConfig: { onSuccess: { destination: ARN }, onFailure: {} } }))).toEqual({
      retries: 0,
      keptMinutes: '2',
      onSuccess: 'failed-orders',
      onFailure: '',
    });
  });

  it('send the form whole, its destinations by name, and none when there are none', () => {
    expect(asyncSettingsBody({ retries: 1, keptMinutes: '90', onSuccess: '', onFailure: 'failed-orders' })).toEqual({
      body: { maximumRetryAttempts: 1, maximumEventAgeInSeconds: 5400, destinationConfig: { onFailure: { destination: 'failed-orders' } } },
    });
    expect(asyncSettingsBody({ retries: 2, keptMinutes: '360', onSuccess: '', onFailure: '' })).toEqual({ body: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 21600 } });
  });

  it.each(['0', '361', '1.5', ''])('refuse to keep a call %j minutes, saying the bounds', (minutes) => {
    expect(asyncSettingsBody({ retries: 2, keptMinutes: minutes, onSuccess: '', onFailure: '' })).toEqual({
      problem: 'A call is kept from 1 minute to 360 minutes (6 hours), in whole minutes',
    });
  });

  it('say times and names as people read them', () => {
    expect([keptText(60), keptText(120), keptText(3600), keptText(21600), keptText(5400)]).toEqual(['1 minute', '2 minutes', '1 hour', '6 hours', '90 minutes']);
    expect([nameOfArn(ARN), nameOfArn(`${ARN}:$LATEST`), nameOfArn(undefined)]).toEqual(['failed-orders', 'failed-orders', '']);
  });
});
