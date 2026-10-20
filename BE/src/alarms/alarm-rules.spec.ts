/**
 * L1: an alarm's rules, as CloudWatch's: what a definition may be, which
 * periods are judged, "M out of N" with each treatment of missing data, the
 * reason, which changes are told, and the e-mail in both languages. The
 * evaluator runs against PostgreSQL in alarms.db.spec.ts.
 */
import { alarmMail } from './alarm-mail';
import { AlarmRule, alarmProblem, datapointsOf, evaluate, evaluationWindow, notifies, stateReason } from './alarm-rules';
import type { MetricsView } from '../metrics/customer-metrics';

const RULE: AlarmRule = {
  functionId: '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f',
  metric: 'Errors',
  statistic: 'Sum',
  period: 60,
  comparison: 'GreaterThanThreshold',
  threshold: 5,
  evaluationPeriods: 3,
  datapointsToAlarm: 2,
  treatMissingData: 'missing',
};

describe('what an alarm may be', () => {
  it("takes each metric with its own statistics, M at most N, and a look back of a day at most", () => {
    expect([alarmProblem(RULE), alarmProblem({ ...RULE, metric: 'Duration', statistic: 'p95' }), alarmProblem({ ...RULE, period: 3600, evaluationPeriods: 24, datapointsToAlarm: 24 })]).toEqual([null, null, null]);
    expect([
      alarmProblem({ ...RULE, statistic: 'p95' }),
      alarmProblem({ ...RULE, metric: 'Duration', statistic: 'Sum' }),
      alarmProblem({ ...RULE, datapointsToAlarm: 4 }),
      alarmProblem({ ...RULE, period: 3600, evaluationPeriods: 25, datapointsToAlarm: 1 }),
    ]).toEqual([
      'Errors has the statistic Sum, not p95',
      'Duration has the statistics Average, Maximum, p50, p95, p99, not Sum',
      "datapointsToAlarm (4) can't be more than evaluationPeriods (3)",
      '25 periods of 3600 s look back more than a day: take fewer periods, or shorter ones',
    ]);
  });

  it("takes the account's money as the account's, read as it is: no function, one datapoint", () => {
    const balance = { ...RULE, functionId: null, metric: 'Balance' as const, statistic: 'Latest' as const, comparison: 'LessThanThreshold' as const, evaluationPeriods: 1, datapointsToAlarm: 1 };
    expect([alarmProblem(balance), alarmProblem({ ...balance, metric: 'MonthToDateCharges' })]).toEqual([null, null]);
    expect([alarmProblem({ ...balance, functionId: RULE.functionId }), alarmProblem({ ...balance, evaluationPeriods: 3 }), alarmProblem({ ...balance, statistic: 'Sum' })]).toEqual([
      "Balance is the account's: a billing alarm names no function",
      'Balance is read as it is: evaluationPeriods and datapointsToAlarm must be 1',
      'Balance has the statistic Latest, not Sum',
    ]);
  });
});

describe('the periods an alarm judges', () => {
  it('are the last N whole periods over for at least the settling time, by UTC', () => {
    const now = new Date('2026-10-20T10:07:30Z');
    expect(evaluationWindow({ period: 60, evaluationPeriods: 3 }, now, 60)).toEqual({ start: new Date('2026-10-20T10:03:00Z'), end: new Date('2026-10-20T10:06:00Z') });
    expect(evaluationWindow({ period: 300, evaluationPeriods: 2 }, now, 60)).toEqual({ start: new Date('2026-10-20T09:55:00Z'), end: new Date('2026-10-20T10:05:00Z') });
    expect(evaluationWindow({ period: 60, evaluationPeriods: 1 }, now, 0)).toEqual({ start: new Date('2026-10-20T10:06:00Z'), end: new Date('2026-10-20T10:07:00Z') });
  });
});

describe('an evaluation, M out of N', () => {
  it('is ALARM when M or more of the N breach, OK when fewer do', () => {
    expect(evaluate(RULE, [1, 6, 7], 'OK')).toEqual({ state: 'ALARM', datapoints: [1, 6, 7], breaching: 2, missing: 0, latest: 7 });
    expect(evaluate(RULE, [6, 1, 2], 'ALARM')).toMatchObject({ state: 'OK', breaching: 1, latest: 2 });
  });

  it('compares as the comparison says: at the threshold breaches only with "or equal"', () => {
    const at = (comparison: AlarmRule['comparison']) => evaluate({ ...RULE, comparison, datapointsToAlarm: 1 }, [5], 'OK').state;
    expect([at('GreaterThanThreshold'), at('GreaterThanOrEqualToThreshold'), at('LessThanThreshold'), at('LessThanOrEqualToThreshold')]).toEqual(['OK', 'ALARM', 'OK', 'ALARM']);
    expect(evaluate({ ...RULE, comparison: 'LessThanThreshold', datapointsToAlarm: 1 }, [4.9], 'OK').state).toBe('ALARM');
  });

  it('missing, by default: all N missing is INSUFFICIENT_DATA, and otherwise the others are judged', () => {
    expect(evaluate(RULE, [null, null, null], 'OK')).toEqual({ state: 'INSUFFICIENT_DATA', datapoints: [null, null, null], breaching: 0, missing: 3, latest: null });
    expect(evaluate(RULE, [null, 6, 7], 'OK')).toMatchObject({ state: 'ALARM', missing: 1 });
    expect(evaluate(RULE, [null, null, 7], 'OK')).toMatchObject({ state: 'OK', breaching: 1 });
  });

  it('notBreaching and breaching count a missing datapoint as named', () => {
    expect(evaluate({ ...RULE, treatMissingData: 'notBreaching' }, [null, null, null], 'ALARM').state).toBe('OK');
    expect(evaluate({ ...RULE, treatMissingData: 'breaching' }, [null, null, 1], 'OK')).toMatchObject({ state: 'ALARM', breaching: 2 });
  });

  it('ignore keeps the state when all N are missing, and judges the others otherwise', () => {
    const ignore = { ...RULE, treatMissingData: 'ignore' as const };
    expect([evaluate(ignore, [null, null, null], 'ALARM').state, evaluate(ignore, [null, null, null], 'OK').state]).toEqual(['ALARM', 'OK']);
    expect(evaluate(ignore, [null, 6, 7], 'OK').state).toBe('ALARM');
  });

  it("says why, as CloudWatch's StateReason", () => {
    expect(stateReason(RULE, evaluate(RULE, [null, 6, 7], 'OK'))).toBe('2 of the last 3 period(s) of 60 s breaching Errors Sum > 5 (2 needed, 1 missing); latest 7');
    expect(stateReason({ ...RULE, metric: 'Duration', statistic: 'p95' }, evaluate(RULE, [null, null, null], 'OK'))).toBe('No datapoint for Duration p95 in the last 3 period(s) of 60 s');
    const balance = { ...RULE, metric: 'Balance' as const, statistic: 'Latest' as const, comparison: 'LessThanThreshold' as const, threshold: 5, datapointsToAlarm: 1 };
    expect(stateReason(balance, evaluate(balance, [2.5], 'OK'))).toBe('Balance is 2.5: breaching Balance < 5');
  });
});

describe('what is told', () => {
  it('a change into ALARM, and out of it; never a change between OK and INSUFFICIENT_DATA, nor none', () => {
    const changes = [
      ['OK', 'ALARM'],
      ['INSUFFICIENT_DATA', 'ALARM'],
      ['ALARM', 'OK'],
      ['ALARM', 'INSUFFICIENT_DATA'],
      ['INSUFFICIENT_DATA', 'OK'],
      ['OK', 'INSUFFICIENT_DATA'],
      ['ALARM', 'ALARM'],
    ] as const;
    expect(changes.map(([from, to]) => notifies(from, to))).toEqual([true, true, true, true, false, false, false]);
  });
});

describe('the datapoints read from the metrics', () => {
  const view = {
    metrics: {
      Invocations: [3, 0],
      Errors: [1, 0],
      Throttles: [0, 2],
      ColdStarts: [1, 0],
      Duration: { Average: [12, null], Maximum: [20, null], p50: [10, null], p95: [19, null], p99: [19.8, null] },
      Instances: { Maximum: [2, 1], Average: [1.5, 1] },
    },
  } as unknown as MetricsView;

  it("are a count's every period, a duration's statistic with its gaps, the instances' statistic", () => {
    expect([datapointsOf(view, 'Throttles', 'Sum'), datapointsOf(view, 'Duration', 'p95'), datapointsOf(view, 'Instances', 'Average')]).toEqual([
      [0, 2],
      [19, null],
      [1.5, 1],
    ]);
  });
});

describe("an alarm's e-mail", () => {
  const change = {
    account: { id: '000000000042', name: 'Tunis Labs' },
    alarm: { ...RULE, name: 'Checkout errors' },
    functionName: 'checkout',
    from: 'OK' as const,
    to: 'ALARM' as const,
    evaluation: evaluate(RULE, [null, 6, 7.5], 'OK'),
    at: new Date('2026-10-20T10:07:30Z'),
    consoleUrl: 'https://console.ff.tn',
  };

  it('says which alarm changed, when, why, and links to the alarms, in English', () => {
    expect(alarmMail(change, 'en')).toEqual({
      subject: 'ALARM: "Checkout errors" (Tunis Labs)',
      text: [
        'Your alarm "Checkout errors" on the function "checkout" of the account "Tunis Labs" (000000000042) went from OK to ALARM at 2026-10-20 10:07 UTC.',
        'Why: 2 of the last 3 period(s) of 60 s meet Errors Sum > 5 (2 needed, 1 without data); latest value: 7.5.',
        '',
        'Your alarms: https://console.ff.tn/alarms',
      ].join('\n'),
    });
  });

  it('and in French, numbers as French writes them', () => {
    expect(alarmMail(change, 'fr')).toEqual({
      subject: 'ALARME : « Checkout errors » (Tunis Labs)',
      text: [
        'Votre alarme « Checkout errors » sur la fonction « checkout » du compte « Tunis Labs » (000000000042) est passée de OK à ALARME le 20 octobre 2026 à 10:07 UTC.',
        'Motif : 2 des 3 dernière(s) période(s) de 60 s remplissent Errors Sum > 5 (2 requise(s), 1 sans donnée) ; dernière valeur : 7,5.',
        '',
        'Vos alarmes : https://console.ff.tn/alarms',
      ].join('\n'),
    });
  });

  it("names the account's alarms as the account's, the money's value as it is, and a recovery with no data", () => {
    const balance = { ...RULE, functionId: null, metric: 'Balance' as const, statistic: 'Latest' as const, comparison: 'LessThanThreshold' as const, threshold: 5, evaluationPeriods: 1, datapointsToAlarm: 1 };
    const low = { ...change, alarm: { ...balance, name: 'Low balance' }, functionName: null, evaluation: evaluate(balance, [2.5], 'OK') };
    expect(alarmMail(low, 'en').text.split('\n').slice(0, 2)).toEqual([
      'Your alarm "Low balance" on the account "Tunis Labs" (000000000042) went from OK to ALARM at 2026-10-20 10:07 UTC.',
      'Why: Balance is 2.5, which meets < 5.',
    ]);
    expect(alarmMail(low, 'fr').text.split('\n').slice(0, 2)).toEqual([
      'Votre alarme « Low balance » sur le compte « Tunis Labs » (000000000042) est passée de OK à ALARME le 20 octobre 2026 à 10:07 UTC.',
      'Motif : Balance vaut 2,5, ce qui remplit la condition < 5.',
    ]);
    expect(alarmMail({ ...low, from: 'ALARM' as const, to: 'OK' as const, evaluation: evaluate(balance, [7], 'ALARM') }, 'en').text.split('\n')[1]).toBe("Why: Balance is 7, which doesn't meet < 5.");
    const quiet = { ...change, from: 'ALARM' as const, to: 'INSUFFICIENT_DATA' as const, evaluation: evaluate(RULE, [null, null, null], 'ALARM') };
    expect([alarmMail(quiet, 'en').subject, alarmMail(quiet, 'fr').subject, alarmMail(quiet, 'fr').text.split('\n')[1]]).toEqual([
      'INSUFFICIENT_DATA: "Checkout errors" (Tunis Labs)',
      'DONNÉES INSUFFISANTES : « Checkout errors » (Tunis Labs)',
      'Motif : Aucune donnée pour Errors Sum dans les 3 dernière(s) période(s) de 60 s.',
    ]);
  });
});
