/**
 * EventBridge's Scheduled Event, which a rule's schedule sends its target, as
 * a function on a schedule gets it, unless the schedule gives an input of its
 * own (SAM's Input). Its region is FF's, FF_REGION.
 */
export interface ScheduledEvent {
  version: '0';
  id: string;
  'detail-type': 'Scheduled Event';
  source: 'aws.events';
  account: string;
  /** When the run was due, to the second, in UTC. */
  time: string;
  region: string;
  /** The rule's ARN. */
  resources: string[];
  detail: Record<string, never>;
}

/** The rule's name in its ARN: the function's and the schedule's, as a function's schedules are its own. */
export const ruleName = (functionName: string, scheduleName: string): string => `${functionName}-${scheduleName}`;

export function scheduledEvent(run: { id: string; account: string; time: Date; region: string; rule: string }): ScheduledEvent {
  return {
    version: '0',
    id: run.id,
    'detail-type': 'Scheduled Event',
    source: 'aws.events',
    account: run.account,
    time: run.time.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    region: run.region,
    resources: [`arn:aws:events:${run.region}:${run.account}:rule/${run.rule}`],
    detail: {},
  };
}
