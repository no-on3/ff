import { describe, expect, it } from 'vitest';
import type { Alarm } from '../services/api';
import { STATE_INFO, conditionText, emptyForm, formFromAlarm, formProblem, metricsFor, toBody, withMetric } from './alarms';

const FN = '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f';

describe('the alarm form', () => {
  it('starts on a function\'s errors as soon as there is one, or the account\'s calls, told to the owners', () => {
    expect(toBody({ ...emptyForm(FN), name: ' Checkout errors ' })).toEqual({
      name: 'Checkout errors',
      functionId: FN,
      metric: 'Errors',
      statistic: 'Sum',
      period: 60,
      comparison: 'GreaterThanThreshold',
      threshold: 0,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
      treatMissingData: 'missing',
      actions: { email: true, webhookUrls: [] },
    });
    expect([emptyForm().functionId, emptyForm().metric]).toEqual(['', 'Invocations']);
    // The account's: no function, sent as null, which the API takes, not as an empty ID.
    expect(toBody({ ...emptyForm(), name: 'Calls' }).functionId).toBeNull();
  });

  it("offers a function's calls, durations and instances, and the account its money too", () => {
    expect(metricsFor(FN)).toEqual(['Invocations', 'Errors', 'Throttles', 'ColdStarts', 'Duration', 'Instances']);
    expect(metricsFor('')).toContain('Balance');
  });

  it("keeps a statistic the new metric has, else takes its first; the money is the account's, one period", () => {
    const duration = withMetric({ ...emptyForm(FN), statistic: 'Sum' }, 'Duration');
    expect(duration.statistic).toBe('Average');
    expect(withMetric({ ...duration, statistic: 'Maximum' }, 'Instances').statistic).toBe('Maximum');
    expect(withMetric({ ...emptyForm(FN), evaluationPeriods: '5', datapointsToAlarm: '3' }, 'Balance')).toMatchObject({ functionId: '', statistic: 'Latest', evaluationPeriods: '1', datapointsToAlarm: '1' });
  });

  it("says what the API would refuse before sending it", () => {
    const form = { ...emptyForm(FN), name: 'Errors' };
    expect(formProblem(form)).toBeNull();
    expect([
      formProblem({ ...form, name: ' ' }),
      formProblem({ ...form, threshold: 'many' }),
      formProblem({ ...form, threshold: '' }),
      formProblem({ ...form, evaluationPeriods: '0' }),
      formProblem({ ...form, evaluationPeriods: '61' }),
      formProblem({ ...form, evaluationPeriods: '3', datapointsToAlarm: '4' }),
      formProblem({ ...form, evaluationPeriods: '2.5' }),
      formProblem({ ...form, period: 3600, evaluationPeriods: '25' }),
      formProblem({ ...form, webhookUrls: 'ftp://example.tn' }),
      formProblem({ ...form, webhookUrls: Array(6).fill('https://example.tn').join('\n') }),
    ]).toEqual([
      'Give the alarm a name',
      'The threshold must be a number',
      'The threshold must be a number',
      'The periods judged must be a whole number from 1 to 60',
      'The periods judged must be a whole number from 1 to 60',
      'The periods breaching must be a whole number from 1 to the 3 judged',
      'The periods judged must be a whole number from 1 to 60',
      'The periods judged look back more than a day: take fewer, or shorter ones',
      'ftp://example.tn: The URL must start with https:// or http://',
      'An alarm tells at most 5 webhooks',
    ]);
    const balance = { ...withMetric(form, 'Balance'), comparison: 'LessThanThreshold' as const, threshold: '5' };
    expect([formProblem(balance), formProblem({ ...balance, functionId: FN }), formProblem({ ...balance, evaluationPeriods: '2', datapointsToAlarm: '1' })]).toEqual([
      null,
      "Balance is the account's: it watches no function",
      'Balance is read as it is: one period',
    ]);
  });

  it('sends the webhooks one per line, blank lines left out, and comes back from an alarm as it was', () => {
    const form = { ...emptyForm(FN), name: 'Errors', webhookUrls: ' https://a.example.tn/ff \n\nhttps://b.example.tn/ff\n' };
    expect(toBody(form).actions.webhookUrls).toEqual(['https://a.example.tn/ff', 'https://b.example.tn/ff']);
    const alarm = { ...toBody(form), id: 'a-1', state: 'OK', stateReason: null, stateChangedAt: null, evaluatedAt: null, createdAt: '', updatedAt: '' } as Alarm;
    expect(toBody(formFromAlarm(alarm))).toEqual(toBody(form));
  });
});

describe('an alarm, as the page says it', () => {
  it('reads its condition with its unit and its periods', () => {
    const base = { metric: 'Errors', statistic: 'Sum', comparison: 'GreaterThanThreshold', threshold: 0, period: 60, evaluationPeriods: 1, datapointsToAlarm: 1 };
    expect(conditionText(base)).toBe('Errors Sum > 0 calls, in the last period of 1 minute');
    expect(conditionText({ ...base, metric: 'Duration', statistic: 'p95', comparison: 'GreaterThanOrEqualToThreshold', threshold: 800, period: 300, evaluationPeriods: 3, datapointsToAlarm: 2 })).toBe(
      'Duration p95 >= 800 ms, in 2 of the last 3 periods of 5 minutes',
    );
    expect(conditionText({ ...base, metric: 'Balance', statistic: 'Latest', comparison: 'LessThanThreshold', threshold: 5 })).toBe('Balance < 5 TND, as it is');
  });

  it('names each state in words, beside its tone', () => {
    expect(STATE_INFO).toEqual({ OK: { label: 'OK', tone: 'ok' }, ALARM: { label: 'In alarm', tone: 'alarm' }, INSUFFICIENT_DATA: { label: 'Insufficient data', tone: 'unknown' } });
  });
});
