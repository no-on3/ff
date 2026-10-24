import type { NotificationConfiguration, NotificationConfigurationBody, NotificationFilter } from '../services/api';

/** S3's event types a bucket of FF's sends, as the API takes them: contract.test.ts checks them against the API's. */
export const EVENT_TYPES = [
  's3:ObjectCreated:*',
  's3:ObjectCreated:Put',
  's3:ObjectCreated:Post',
  's3:ObjectCreated:Copy',
  's3:ObjectCreated:CompleteMultipartUpload',
  's3:ObjectRemoved:*',
  's3:ObjectRemoved:Delete',
  's3:ObjectRemoved:DeleteMarkerCreated',
] as const;

/** S3's events, in a few words each. */
export const EVENT_WORDS: Record<string, string> = {
  's3:ObjectCreated:*': 'every new object',
  's3:ObjectCreated:Put': 'uploads in one piece',
  's3:ObjectCreated:Post': 'uploads by a form',
  's3:ObjectCreated:Copy': 'copies',
  's3:ObjectCreated:CompleteMultipartUpload': 'uploads in parts',
  's3:ObjectRemoved:*': 'every deletion',
  's3:ObjectRemoved:Delete': 'deletions',
  's3:ObjectRemoved:DeleteMarkerCreated': 'delete markers',
};

/** The events the form offers: the two wildcards, and the kinds FF's buckets send. */
export const FORM_EVENTS = ['s3:ObjectCreated:*', 's3:ObjectCreated:Put', 's3:ObjectCreated:Copy', 's3:ObjectCreated:CompleteMultipartUpload', 's3:ObjectRemoved:*'] as const;

/** One configuration, a function's or a queue's, as the panel shows it. */
export interface NotificationEntry {
  id: string;
  target: 'function' | 'queue';
  /** The destination's ARN, as the API keeps it. */
  arn: string;
  events: string[];
  prefix: string;
  suffix: string;
}

/** The name an ARN ends with: a function's or a queue's. */
export const nameOfArn = (arn: string): string => arn.slice(arn.lastIndexOf(':') + 1);

const filterValue = (filter: NotificationFilter | undefined, name: string): string =>
  filter?.key.filterRules.find((rule) => rule.name.toLowerCase() === name)?.value ?? '';

/** The configurations of the API's answer, the functions' first. */
export function entriesOf(configuration: NotificationConfiguration): NotificationEntry[] {
  return [
    ...configuration.lambdaFunctionConfigurations.map((item) => ({
      id: item.id,
      target: 'function' as const,
      arn: item.lambdaFunctionArn,
      events: item.events,
      prefix: filterValue(item.filter, 'prefix'),
      suffix: filterValue(item.filter, 'suffix'),
    })),
    ...configuration.queueConfigurations.map((item) => ({
      id: item.id,
      target: 'queue' as const,
      arn: item.queueArn,
      events: item.events,
      prefix: filterValue(item.filter, 'prefix'),
      suffix: filterValue(item.filter, 'suffix'),
    })),
  ];
}

/** A configuration in words: its events, the keys it names, and where they go. */
export function notificationText(entry: Pick<NotificationEntry, 'target' | 'arn' | 'events' | 'prefix' | 'suffix'>): string {
  const events = entry.events.map((event) => EVENT_WORDS[event] ?? event).join(', ');
  const keys = [entry.prefix && `beginning with ${entry.prefix}`, entry.suffix && `ending with ${entry.suffix}`].filter(Boolean).join(' and ');
  const to = entry.target === 'function' ? `run the function ${nameOfArn(entry.arn)}, without waiting` : `go to the queue ${nameOfArn(entry.arn)}`;
  return `${events}${keys ? ` of keys ${keys}` : ''}: ${to}`;
}

/** The PUT that keeps these configurations: the API keeps the whole list it is given. */
export function configurationBody(entries: NotificationEntry[]): NotificationConfigurationBody {
  const filter = (entry: NotificationEntry): { filter?: NotificationFilter } => {
    const filterRules = [
      ...(entry.prefix ? [{ name: 'prefix', value: entry.prefix }] : []),
      ...(entry.suffix ? [{ name: 'suffix', value: entry.suffix }] : []),
    ];
    return filterRules.length ? { filter: { key: { filterRules } } } : {};
  };
  const id = (entry: NotificationEntry) => (entry.id ? { id: entry.id } : {});
  return {
    lambdaFunctionConfigurations: entries
      .filter((entry) => entry.target === 'function')
      .map((entry) => ({ ...id(entry), lambdaFunctionArn: entry.arn, events: entry.events, ...filter(entry) })),
    queueConfigurations: entries.filter((entry) => entry.target === 'queue').map((entry) => ({ ...id(entry), queueArn: entry.arn, events: entry.events, ...filter(entry) })),
  };
}

/** The form for a new configuration: its destination as `function:<name>` or `queue:<name>`, '' until chosen. */
export interface NotificationForm {
  destination: string;
  events: string[];
  prefix: string;
  suffix: string;
}

export const emptyNotificationForm = (): NotificationForm => ({ destination: '', events: ['s3:ObjectCreated:*'], prefix: '', suffix: '' });

/** The new configuration the form makes, its destination by name, which the API keeps as its ARN; or what is wrong in it. */
export function entryOf(form: NotificationForm): { entry: NotificationEntry } | { problem: string } {
  const [target, name] = form.destination.split(/:(.*)/s);
  if ((target !== 'function' && target !== 'queue') || !name) return { problem: 'Choose the function or the queue its events go to' };
  if (form.events.length === 0) return { problem: 'Choose at least one event' };
  if (form.events.includes('s3:ObjectCreated:*') && form.events.some((event) => event.startsWith('s3:ObjectCreated:') && event !== 's3:ObjectCreated:*')) {
    return { problem: 'Every new object takes uploads, copies and uploads in parts already: choose it alone, or some of them' };
  }
  return { entry: { id: '', target, arn: name, events: form.events, prefix: form.prefix.trim(), suffix: form.suffix.trim() } };
}
