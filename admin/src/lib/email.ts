/**
 * An account's mail, as GET /admin/accounts/:id/email gives it (ADR 0012),
 * and the three changes an operator makes to it. contract.test.ts compares the
 * fields and the changes with the backend's DTOs.
 */
export type EnforcementStatus = 'HEALTHY' | 'PROBATION' | 'SHUTDOWN';

export interface AccountEmailIdentity {
  identity: string;
  type: 'DOMAIN' | 'EMAIL_ADDRESS';
  status: 'PENDING' | 'SUCCESS' | 'FAILED' | 'TEMPORARY_FAILURE';
}

export interface AccountEmail {
  sandbox: boolean;
  sendingEnabled: boolean;
  enforcementStatus: EnforcementStatus;
  max24HourSend: number;
  maxSendRate: number;
  sentLast24Hours: number;
  reason: string | null;
  updatedAt: string | null;
  identities: AccountEmailIdentity[];
}

export const ACCOUNT_EMAIL_FIELDS = ['sandbox', 'sendingEnabled', 'enforcementStatus', 'max24HourSend', 'maxSendRate', 'sentLast24Hours', 'reason', 'updatedAt', 'identities'] as const;
export const EMAIL_CHANGE_FIELDS = ['productionAccess', 'sendingEnabled', 'enforcementStatus'] as const;

/** One change an operator makes, as PUT /admin/accounts/:id/email takes it. */
export type EmailChange = { productionAccess: boolean } | { sendingEnabled: boolean } | { enforcementStatus: 'HEALTHY' };

/** As SES's EnforcementStatus, in words. */
export const ENFORCEMENT: Record<EnforcementStatus, string> = {
  HEALTHY: 'Healthy',
  PROBATION: 'Under review: past 5% of bounces or 0.1% of complaints',
  SHUTDOWN: 'Stopped: past 10% of bounces or 0.5% of complaints',
};

export const enforcementLabel = (status: string): string => ENFORCEMENT[status as EnforcementStatus] ?? status;

/** What it sent of its quota: "12 of 200 messages in the last 24 hours, 1 a second at most". */
export function quotaLabel(email: Pick<AccountEmail, 'sentLast24Hours' | 'max24HourSend' | 'maxSendRate'>): string {
  const count = (n: number) => n.toLocaleString('en-US');
  return `${count(email.sentLast24Hours)} of ${count(email.max24HourSend)} messages in the last 24 hours, ${count(email.maxSendRate)} a second at most`;
}

/** A proved identity, and one waiting: "shop.example.tn (proved)", "ana@example.tn (waiting for its link)". */
export function identityLabel({ identity, type, status }: AccountEmailIdentity): string {
  if (status === 'SUCCESS') return `${identity} (proved)`;
  if (status === 'PENDING') return `${identity} (${type === 'DOMAIN' ? 'waiting for its DKIM record' : 'waiting for its link'})`;
  if (status === 'TEMPORARY_FAILURE') return `${identity} (its record gone since it was proved)`;
  return `${identity} (not proved)`;
}

/** The dialog of a change: its title, what it does, its button. */
export function emailChangeDialog(change: EmailChange, accountName: string): { title: string; body: string; confirmLabel: string } {
  const owners = 'Its owners get an e-mail that gives your reason, and its members read it in their audit log.';
  if ('productionAccess' in change) {
    return change.productionAccess
      ? {
          title: `Let ${accountName}'s mail out of the sandbox?`,
          body: `Its mail may then go to any address, within its plan's quotas, not only to the addresses and domains it proved. ${owners}`,
          confirmLabel: 'Let it out',
        }
      : {
          title: `Put ${accountName}'s mail back in the sandbox?`,
          body: `Its mail then goes only to the addresses and domains it proved. ${owners}`,
          confirmLabel: 'Put it back',
        };
  }
  if ('sendingEnabled' in change) {
    return change.sendingEnabled
      ? { title: `Turn ${accountName}'s sending on again?`, body: `The SES endpoint takes its messages again. ${owners}`, confirmLabel: 'Turn on' }
      : {
          title: `Pause ${accountName}'s sending?`,
          body: `The SES endpoint refuses its messages (SendingPausedException) until it is on again; what is queued already goes. ${owners}`,
          confirmLabel: 'Pause',
        };
  }
  return {
    title: `Clear ${accountName}'s mail after a review?`,
    body: `Its standing goes back to healthy: its rates raise it again only with new bounces or complaints. ${owners}`,
    confirmLabel: 'Clear',
  };
}
