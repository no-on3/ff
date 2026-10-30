import { describe, expect, it } from 'vitest';
import { emailChangeDialog, enforcementLabel, identityLabel, quotaLabel } from './email';

describe("an account's mail", () => {
  it('says what it sent of its quota, and its standing in words', () => {
    expect(quotaLabel({ sentLast24Hours: 1200, max24HourSend: 50000, maxSendRate: 14 })).toBe('1,200 of 50,000 messages in the last 24 hours, 14 a second at most');
    expect([enforcementLabel('HEALTHY'), enforcementLabel('SHUTDOWN'), enforcementLabel('NEW')]).toEqual(['Healthy', 'Stopped: past 10% of bounces or 0.5% of complaints', 'NEW']);
  });

  it('says where each identity is', () => {
    expect(
      [
        { identity: 'shop.example.tn', type: 'DOMAIN', status: 'SUCCESS' },
        { identity: 'news.example.tn', type: 'DOMAIN', status: 'PENDING' },
        { identity: 'ana@example.tn', type: 'EMAIL_ADDRESS', status: 'PENDING' },
        { identity: 'old.example.tn', type: 'DOMAIN', status: 'TEMPORARY_FAILURE' },
        { identity: 'late.example.tn', type: 'DOMAIN', status: 'FAILED' },
      ].map((identity) => identityLabel(identity as Parameters<typeof identityLabel>[0])),
    ).toEqual([
      'shop.example.tn (proved)',
      'news.example.tn (waiting for its DKIM record)',
      'ana@example.tn (waiting for its link)',
      'old.example.tn (its record gone since it was proved)',
      'late.example.tn (not proved)',
    ]);
  });

  it('asks before each change, saying what it does and that the owners are told', () => {
    const dialogs = [{ productionAccess: true }, { productionAccess: false }, { sendingEnabled: false }, { sendingEnabled: true }, { enforcementStatus: 'HEALTHY' as const }].map((change) =>
      emailChangeDialog(change, 'Tunis Labs'),
    );

    expect(dialogs.map(({ title, confirmLabel }) => [title, confirmLabel])).toEqual([
      ["Let Tunis Labs's mail out of the sandbox?", 'Let it out'],
      ["Put Tunis Labs's mail back in the sandbox?", 'Put it back'],
      ["Pause Tunis Labs's sending?", 'Pause'],
      ["Turn Tunis Labs's sending on again?", 'Turn on'],
      ["Clear Tunis Labs's mail after a review?", 'Clear'],
    ]);
    expect(dialogs.every(({ body }) => body.endsWith('Its owners get an e-mail that gives your reason, and its members read it in their audit log.'))).toBe(true);
    expect(dialogs[2].body).toContain('SendingPausedException');
  });
});
