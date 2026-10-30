import { describe, expect, it } from 'vitest';
import type { EmailIdentity, EmailMetrics } from '../services/api';
import { addressList, identityProblem, lastDayLabel, quotaLabel, recipientsSummary, senders, sendingNotice, sesCommand } from './email';

const identity = (name: string, status: EmailIdentity['status'], type: EmailIdentity['type'] = 'DOMAIN'): EmailIdentity => ({
  identity: name,
  type,
  status,
  sendingEnabled: status === 'SUCCESS',
  dkimSelector: type === 'DOMAIN' ? 'ff0a1b2c3d' : null,
  mailFromDomain: type === 'DOMAIN' ? `bounces.mail.${name}` : null,
  mailFromVerified: false,
  records: [],
  verifiedAt: null,
  createdAt: '2026-10-30T08:00:00Z',
});

describe("customers' mail on the E-mail page", () => {
  it('takes a domain or an address, and says why it would refuse one', () => {
    expect([identityProblem('shop.example.tn'), identityProblem(' Orders@Shop.Example.TN '), identityProblem('ana@mail.co.tn')]).toEqual([null, null, null]);
    expect(identityProblem('')).toBe('A domain, such as shop.example.tn, or an address, such as orders@shop.example.tn');
    expect(identityProblem('@shop.example.tn')).toBe('An address has one @, with something before it');
    expect(identityProblem('a@b@shop.example.tn')).toBe('An address has one @, with something before it');
    expect(identityProblem('localhost')).toBe('localhost is not a domain, such as shop.example.tn');
    expect(identityProblem('ana@')).toBe('The domain is not a domain, such as shop.example.tn');
  });

  it('says what the account sent of its quota, and what holds its mail back, the worst first', () => {
    const healthy = { sandbox: false, sendingEnabled: true, enforcementStatus: 'HEALTHY' as const };

    expect(quotaLabel({ sentLast24Hours: 12, max24HourSend: 200, maxSendRate: 1 })).toBe('12 of 200 messages in the last 24 hours, 1 a second at most');
    expect(sendingNotice(healthy)).toBeNull();
    expect(sendingNotice({ ...healthy, sandbox: true })).toMatch(/^In the sandbox, as every new account is/);
    expect(sendingNotice({ ...healthy, sandbox: true, enforcementStatus: 'PROBATION' })).toMatch(/^Its sending is under review/);
    expect(sendingNotice({ ...healthy, enforcementStatus: 'SHUTDOWN' })).toMatch(/^Its sending is stopped/);
    expect(sendingNotice({ ...healthy, sendingEnabled: false, enforcementStatus: 'SHUTDOWN' })).toMatch(/^FF's operator paused this account's sending/);
  });

  it('offers to send from each proved address, and from an address at each proved domain', () => {
    expect(senders([identity('shop.example.tn', 'SUCCESS'), identity('news.example.tn', 'PENDING'), identity('ana@example.tn', 'SUCCESS', 'EMAIL_ADDRESS')])).toEqual([
      'noreply@shop.example.tn',
      'ana@example.tn',
    ]);
  });

  it("says each recipient's fate, takes addresses as typed, and gives the CLI's command", () => {
    expect(
      recipientsSummary({
        recipients: [
          { address: 'ana@example.tn', status: 'SENT', diagnostic: null },
          { address: 'gone@example.tn', status: 'BOUNCED', diagnostic: 'smtp; 550 5.1.1' },
        ],
      }),
    ).toBe('ana@example.tn sent, gone@example.tn bounced');
    expect(addressList(' ana@example.tn, sami@example.tn;lina@example.tn  ')).toEqual(['ana@example.tn', 'sami@example.tn', 'lina@example.tn']);
    expect(sesCommand('noreply@shop.example.tn', 'ana@example.tn')).toBe(
      [
        'aws sesv2 send-email \\',
        '  --from-email-address noreply@shop.example.tn \\',
        '  --destination ToAddresses=ana@example.tn \\',
        `  --content '{"Simple": {"Subject": {"Data": "Hello"}, "Body": {"Text": {"Data": "Sent through FF."}}}}'`,
      ].join('\n'),
    );
  });
});

describe("the last day's mail, in words", () => {
  const metrics = (send: number[], bounce: number[], complaint: number[], bounceRate: Array<number | null>, complaintRate: Array<number | null>): EmailMetrics => ({
    period: 3600,
    start: '2026-10-29T10:00:00.000Z',
    end: '2026-10-29T12:00:00.000Z',
    timestamps: ['2026-10-29T10:00:00.000Z', '2026-10-29T11:00:00.000Z'],
    metrics: {
      Send: { Sum: send },
      Delivery: { Sum: send },
      Bounce: { Sum: bounce },
      Complaint: { Sum: complaint },
      'Reputation.BounceRate': { Average: bounceRate },
      'Reputation.ComplaintRate': { Average: complaintRate },
    },
  });

  it("adds the day's hours up, and gives its latest reputation over 14 days against SES's review", () => {
    expect(lastDayLabel(metrics([1_000, 200], [12, 3], [0, 1], [0.0125, 0.012], [0.0005, 0.001]))).toBe(
      '1,200 sent in the last 24 hours, 15 bounced, 1 complained of. Over 14 days, 1.2% of its recipients bounced and 0.1% complained: SES reviews past 5% and 0.1%.',
    );
  });

  it('says nothing was sent, and no reputation without a recipient reached', () => {
    expect(lastDayLabel(metrics([0, 0], [0, 0], [0, 0], [null, null], [null, null]))).toBe('Nothing sent in the last 24 hours.');
  });
});
