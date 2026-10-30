import { frenchDecimal, frenchTime } from '../common/french';
import type { Language } from '../mail/language';
import type { Mail } from '../mail/mail.service';
import { AlarmRule, AlarmState, BILLING_METRICS, Evaluation, SYMBOL } from './alarm-rules';

export interface AlarmChange {
  account: { id: string; name: string };
  alarm: Pick<AlarmRule, 'metric' | 'statistic' | 'period' | 'comparison' | 'threshold' | 'evaluationPeriods' | 'datapointsToAlarm'> & { name: string };
  /** The alarm's function's name, or null for the account's. */
  functionName: string | null;
  /** The alarm's database's name, for a database's metric; null otherwise. */
  databaseName?: string | null;
  /** The alarm's bucket's name, for a bucket's metric; null otherwise. */
  bucketName?: string | null;
  /** The alarm's queue's name, for a queue's metric; null otherwise. */
  queueName?: string | null;
  /** The alarm's cache's name, for a cache's metric; null otherwise. */
  cacheName?: string | null;
  from: AlarmState;
  to: AlarmState;
  evaluation: Evaluation;
  at: Date;
  consoleUrl: string;
}

const FRENCH_STATES: Record<AlarmState, string> = { OK: 'OK', ALARM: 'ALARME', INSUFFICIENT_DATA: 'DONNÉES INSUFFISANTES' };
const frenchNumber = (value: number | null) => (value === null ? 'aucune' : frenchDecimal(String(value)));

/** The e-mail of an alarm's change, in the owner's language: what changed, when, why, and the alarm's rule. */
export function alarmMail(change: AlarmChange, language: Language): Omit<Mail, 'to'> {
  const { alarm, evaluation: e } = change;
  const billing = BILLING_METRICS.includes(alarm.metric);
  const what = billing ? alarm.metric : `${alarm.metric} ${alarm.statistic}`;
  const allMissing = e.missing === e.datapoints.length;
  if (language === 'fr') {
    const account = `du compte « ${change.account.name} » (${change.account.id})`;
    const on = change.functionName
      ? `la fonction « ${change.functionName} » ${account}`
      : change.databaseName
        ? `la base de données « ${change.databaseName} » ${account}`
        : change.bucketName
          ? `le bucket « ${change.bucketName} » ${account}`
          : change.queueName
            ? `la file d'attente « ${change.queueName} » ${account}`
            : change.cacheName
              ? `le cache « ${change.cacheName} » ${account}`
              : `le compte « ${change.account.name} » (${change.account.id})`;
    const reason = allMissing
      ? `Aucune donnée pour ${what} dans les ${e.datapoints.length} dernière(s) période(s) de ${alarm.period} s.`
      : billing
        ? `${alarm.metric} vaut ${frenchNumber(e.latest)}, ce qui ${e.breaching ? 'remplit' : 'ne remplit pas'} la condition ${SYMBOL[alarm.comparison]} ${frenchDecimal(String(alarm.threshold))}.`
        : `${e.breaching} des ${e.datapoints.length} dernière(s) période(s) de ${alarm.period} s remplissent ${what} ${SYMBOL[alarm.comparison]} ${frenchDecimal(String(alarm.threshold))} (${alarm.datapointsToAlarm} requise(s)${e.missing ? `, ${e.missing} sans donnée` : ''}) ; dernière valeur : ${frenchNumber(e.latest)}.`;
    return {
      subject: `${FRENCH_STATES[change.to]} : « ${alarm.name} » (${change.account.name})`,
      text: [
        `Votre alarme « ${alarm.name} » sur ${on} est passée de ${FRENCH_STATES[change.from]} à ${FRENCH_STATES[change.to]} le ${frenchTime(change.at)}.`,
        `Motif : ${reason}`,
        '',
        `Vos alarmes : ${change.consoleUrl}/alarms`,
      ].join('\n'),
    };
  }
  const on = change.functionName
    ? `the function "${change.functionName}" of the account "${change.account.name}" (${change.account.id})`
    : change.databaseName
      ? `the database "${change.databaseName}" of the account "${change.account.name}" (${change.account.id})`
      : change.bucketName
        ? `the bucket "${change.bucketName}" of the account "${change.account.name}" (${change.account.id})`
        : change.queueName
          ? `the queue "${change.queueName}" of the account "${change.account.name}" (${change.account.id})`
          : change.cacheName
            ? `the cache "${change.cacheName}" of the account "${change.account.name}" (${change.account.id})`
            : `the account "${change.account.name}" (${change.account.id})`;
  const breach = `${what} ${SYMBOL[alarm.comparison]} ${alarm.threshold}`;
  const reason = allMissing
    ? `No datapoint for ${what} in the last ${e.datapoints.length} period(s) of ${alarm.period} s.`
    : billing
      ? `${alarm.metric} is ${e.latest}, which ${e.breaching ? 'meets' : "doesn't meet"} ${SYMBOL[alarm.comparison]} ${alarm.threshold}.`
      : `${e.breaching} of the last ${e.datapoints.length} period(s) of ${alarm.period} s meet ${breach} (${alarm.datapointsToAlarm} needed${e.missing ? `, ${e.missing} without data` : ''}); latest value: ${e.latest ?? 'none'}.`;
  return {
    subject: `${change.to}: "${alarm.name}" (${change.account.name})`,
    text: [
      `Your alarm "${alarm.name}" on ${on} went from ${change.from} to ${change.to} at ${change.at.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
      `Why: ${reason}`,
      '',
      `Your alarms: ${change.consoleUrl}/alarms`,
    ].join('\n'),
  };
}
