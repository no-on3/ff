/**
 * L1: the low-balance e-mails (client-readiness plan, P-33): which shares of
 * the last credit the balance has reached, and what the owners read. The
 * service runs against PostgreSQL in credit.db.spec.ts.
 */
import { lowBalanceMail, sharesReached } from './low-balance';

const CREDIT = 50000n; // 50.000 TND
const POLICY = { bufferMinor: 1000n, graceMs: 24 * 3_600_000, shadow: false };

describe('the low-balance e-mails (L1, P-33)', () => {
  it('reaches a share at it exactly, and every larger one with it', () => {
    expect(sharesReached(25001n, CREDIT, [50, 20, 0], new Set())).toEqual([]);
    expect(sharesReached(25000n, CREDIT, [50, 20, 0], new Set())).toEqual([50]);
    expect(sharesReached(10000n, CREDIT, [50, 20, 0], new Set())).toEqual([50, 20]);
    expect(sharesReached(0n, CREDIT, [50, 20, 0], new Set())).toEqual([50, 20, 0]);
    expect(sharesReached(-500n, CREDIT, [50, 20, 0], new Set())).toEqual([50, 20, 0]);
  });

  it('names each share once per credit: one already e-mailed is not reached again', () => {
    expect(sharesReached(9000n, CREDIT, [50, 20, 0], new Set([50]))).toEqual([20]);
    expect(sharesReached(9000n, CREDIT, [50, 20, 0], new Set([50, 20]))).toEqual([]);
  });

  it('counts exactly, in minor units: a third of 0.010 TND', () => {
    expect(sharesReached(3n, 10n, [33], new Set())).toEqual([33]); // 300 ≤ 330
    expect(sharesReached(4n, 10n, [33], new Set())).toEqual([]);
  });

  it('follows the shares the owners set, and none at all for none', () => {
    expect(sharesReached(1000n, CREDIT, [80, 10], new Set())).toEqual([80, 10]);
    expect(sharesReached(-1n, CREDIT, [], new Set())).toEqual([]);
  });

  it("tells the owners the balance, the share of the last credit, and when invokes would stop", () => {
    const mail = lowBalanceMail({
      account: { id: '000000000001', name: 'Tunis Labs' },
      percent: 20,
      balanceMinor: 9800n,
      creditMinor: CREDIT,
      creditAt: new Date('2026-10-17T10:00:00Z'),
      currency: 'TND',
      exponent: 3,
      policy: POLICY,
      consoleUrl: 'https://console.ff.example',
    }, 'en');

    expect(mail).toEqual({
      subject: 'Your FF credit is down to 20%: Tunis Labs',
      text: [
        'The balance of your account "Tunis Labs" (000000000001) is 9.800 TND: 20% or less of your last credit, 50.000 TND on 2026-10-17.',
        '',
        'Add credit before invokes stop: they go on down to -1.000 TND, then for 24 hours more. Reads, logs and deploys always go on.',
        '',
        'Your balance, and when these e-mails come: https://console.ff.example/billing',
      ].join('\n'),
    });
  });

  it('says the credit is used up at 0%', () => {
    const mail = lowBalanceMail({
      account: { id: '000000000001', name: 'Tunis Labs' },
      percent: 0,
      balanceMinor: -120n,
      creditMinor: CREDIT,
      creditAt: new Date('2026-10-17T10:00:00Z'),
      currency: 'TND',
      exponent: 3,
      policy: POLICY,
      consoleUrl: 'https://console.ff.example',
    }, 'en');

    expect(mail.subject).toBe('Your FF credit has run out: Tunis Labs');
    expect(mail.text.split('\n')[0]).toBe('The balance of your account "Tunis Labs" (000000000001) is -0.120 TND: your last credit, 50.000 TND on 2026-10-17, is used up.');
  });
});

describe('the low-balance e-mails, in French', () => {
  const NB = ' ';
  const facts = {
    account: { id: '000000000001', name: 'Tunis Labs' },
    balanceMinor: 9800n,
    creditMinor: CREDIT,
    creditAt: new Date('2026-10-17T10:00:00Z'),
    currency: 'TND',
    exponent: 3,
    policy: POLICY,
    consoleUrl: 'https://console.ff.example',
  };

  it('tell the owners the balance, the share of the last credit, and when invokes would stop, as the invoices write amounts and days', () => {
    expect(lowBalanceMail({ ...facts, percent: 20 }, 'fr')).toEqual({
      subject: `Votre crédit FF est descendu à 20${NB}% : Tunis Labs`,
      text: [
        `Le solde de votre compte « Tunis Labs » (000000000001) est de 9,800${NB}TND : 20${NB}% ou moins de votre dernier crédit, 50,000${NB}TND le 17 octobre 2026.`,
        '',
        `Ajoutez du crédit avant que les invocations s'arrêtent : elles continuent jusqu'à un solde de -1,000${NB}TND, puis pendant 24 heures encore. Les lectures, les journaux et les déploiements continuent toujours.`,
        '',
        'Votre solde, et quand ces e-mails arrivent : https://console.ff.example/billing',
      ].join('\n'),
    });
  });

  it('say the credit is used up at 0%', () => {
    const mail = lowBalanceMail({ ...facts, percent: 0, balanceMinor: -120n }, 'fr');

    expect(mail.subject).toBe('Votre crédit FF est épuisé : Tunis Labs');
    expect(mail.text.split('\n')[0]).toBe(`Le solde de votre compte « Tunis Labs » (000000000001) est de -0,120${NB}TND : votre dernier crédit, 50,000${NB}TND le 17 octobre 2026, est épuisé.`);
  });
});
