/**
 * L1: the rules of credit grants (client-readiness plan, P-74): what an
 * amount may be, when the large-credit threshold asks for the amount again
 * (D12), and the owners' e-mail. The grants themselves run against
 * PostgreSQL in admin-credits.db.spec.ts.
 */
import { LedgerTransactionKind } from '../billing/ledger/ledger-transaction.entity';
import { GRANT_ACTIONS, GRANT_KINDS, confirmationProblem, grantKey, grantMail, grantProblem, needsConfirmation } from './credit-grants';

const { PROMO, ADJUSTMENT } = LedgerTransactionKind;
/** 100.000 TND, the threshold's default. */
const THRESHOLD = 100_000n;

describe('credit grants (L1, P-74)', () => {
  it('are promotions and corrections, each its own audit action, keyed by the client', () => {
    expect(GRANT_KINDS).toEqual(['promo', 'adjustment']);
    expect(GRANT_ACTIONS).toEqual({ promo: 'credit.promo', adjustment: 'credit.adjustment' });
    expect(grantKey('0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f')).toBe('grant:0b7c6f2e-5d1a-4c3b-9e8f-7a6b5c4d3e2f');
  });

  describe('the amount', () => {
    it('takes a promotion above 0, and a correction either way', () => {
      expect([grantProblem(PROMO, 1n, 3, 'TND'), grantProblem(ADJUSTMENT, 5000n, 3, 'TND'), grantProblem(ADJUSTMENT, -5000n, 3, 'TND')]).toEqual([null, null, null]);
    });

    it('refuses 0, of either kind', () => {
      expect([grantProblem(PROMO, 0n, 3, 'TND'), grantProblem(ADJUSTMENT, 0n, 3, 'TND')]).toEqual([
        'amount must not be 0: a grant moves the balance',
        'amount must not be 0: a grant moves the balance',
      ]);
    });

    it('refuses a promotion that takes credit away, naming what does', () => {
      expect(grantProblem(PROMO, -1n, 3, 'TND')).toBe('A promotion adds credit: its amount is above 0. A correction (kind adjustment) takes credit away');
    });

    it('moves 1,000,000 units of the currency at most, either way', () => {
      const limit = 1_000_000_000n; // 1,000,000.000 TND
      expect([grantProblem(PROMO, limit, 3, 'TND'), grantProblem(ADJUSTMENT, -limit, 3, 'TND')]).toEqual([null, null]);
      expect([grantProblem(PROMO, limit + 1n, 3, 'TND'), grantProblem(ADJUSTMENT, -limit - 1n, 3, 'TND')]).toEqual([
        'A grant moves 1000000.000 TND at most, either way',
        'A grant moves 1000000.000 TND at most, either way',
      ]);
      // In the currency's own minor units: 2 decimals for EUR.
      expect(grantProblem(PROMO, 100_000_001n, 2, 'EUR')).toBe('A grant moves 1000000.00 EUR at most, either way');
    });
  });

  describe('the second confirmation (D12)', () => {
    it('is needed above the threshold, either way, and not at it', () => {
      expect([needsConfirmation(THRESHOLD, THRESHOLD), needsConfirmation(-THRESHOLD, THRESHOLD)]).toEqual([false, false]);
      expect([needsConfirmation(THRESHOLD + 1n, THRESHOLD), needsConfirmation(-THRESHOLD - 1n, THRESHOLD)]).toEqual([true, true]);
    });

    it('asks for the amount again above the threshold, naming both', () => {
      expect(confirmationProblem(250_000n, undefined, THRESHOLD, 3, 'TND')).toBe(
        '250.000 TND is above the large-credit threshold, 100.000 TND: type the amount again as confirmAmount to grant it (D12)',
      );
      expect(confirmationProblem(-250_000n, undefined, THRESHOLD, 3, 'TND')).toBe(
        '250.000 TND is above the large-credit threshold, 100.000 TND: type the amount again as confirmAmount to grant it (D12)',
      );
    });

    it('takes the amount typed again, to the minor unit and with its sign', () => {
      expect([confirmationProblem(250_000n, 250_000n, THRESHOLD, 3, 'TND'), confirmationProblem(-250_000n, -250_000n, THRESHOLD, 3, 'TND')]).toEqual([null, null]);
      expect(confirmationProblem(250_000n, 250_001n, THRESHOLD, 3, 'TND')).toBe('confirmAmount is 250.001, not the amount, 250.000: nothing was granted');
      expect(confirmationProblem(-250_000n, 250_000n, THRESHOLD, 3, 'TND')).toBe('confirmAmount is 250.000, not the amount, -250.000: nothing was granted');
    });

    it('needs nothing at or below the threshold, but a confirmation sent must still be the amount', () => {
      expect([confirmationProblem(THRESHOLD, undefined, THRESHOLD, 3, 'TND'), confirmationProblem(5000n, 5000n, THRESHOLD, 3, 'TND')]).toEqual([null, null]);
      expect(confirmationProblem(5000n, 50_000n, THRESHOLD, 3, 'TND')).toBe('confirmAmount is 50.000, not the amount, 5.000: nothing was granted');
    });
  });

  describe("the owners' e-mail", () => {
    const facts = {
      account: { id: '000000000042', name: 'Tunis Labs' },
      currency: 'TND',
      exponent: 3,
      reason: 'Welcome credit for the pilot',
      consoleUrl: 'https://console.ff.example',
    };

    it('says what a promotion added, why, and the balance', () => {
      expect(grantMail({ ...facts, kind: PROMO, amountMinor: 25_000n, balanceMinor: 37_500n })).toEqual({
        subject: 'FF added credit to your account: Tunis Labs',
        text: [
          'FF added 25.000 TND of credit to your account "Tunis Labs" (000000000042).',
          'Why: Welcome credit for the pilot',
          'The balance is now 37.500 TND.',
          '',
          'Your balance, and what moved it: https://console.ff.example/billing',
        ].join('\n'),
      });
    });

    it('says a correction added credit, or took it away', () => {
      const added = grantMail({ ...facts, kind: ADJUSTMENT, amountMinor: 1_500n, balanceMinor: 1_250n, reason: 'Hours billed twice on 2026-10-14' });
      const taken = grantMail({ ...facts, kind: ADJUSTMENT, amountMinor: -2_000n, balanceMinor: -750n, reason: 'Transfer recorded twice' });

      expect([added.subject, added.text.split('\n').slice(0, 3)]).toEqual([
        'FF corrected your credit: Tunis Labs',
        ['FF corrected the credit of your account "Tunis Labs" (000000000042): 1.500 TND added.', 'Why: Hours billed twice on 2026-10-14', 'The balance is now 1.250 TND.'],
      ]);
      expect([taken.subject, taken.text.split('\n').slice(0, 3)]).toEqual([
        'FF corrected your credit: Tunis Labs',
        ['FF corrected the credit of your account "Tunis Labs" (000000000042): 2.000 TND taken away.', 'Why: Transfer recorded twice', 'The balance is now -0.750 TND.'],
      ]);
    });
  });
});
