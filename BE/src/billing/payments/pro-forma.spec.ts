/**
 * L1: pro-formas and bank transfers (client-readiness plan, P-35, D9): the
 * VAT on top of the credit, the payment reference, what a transfer recorded
 * against a pro-forma must add up to, and the owners' e-mails. The ledger
 * entries run against PostgreSQL in payments.db.spec.ts.
 */
import { CREDIT_LIMITS, REFERENCE, VAT_PERCENT, newReference, normalizedReference, transferMail, transferProblem, vatOf, withholdingMail } from './pro-forma';

const AMOUNTS = { creditMinor: 50000n, vatMinor: 9500n, totalMinor: 59500n };

describe('pro-formas and bank transfers (L1, P-35)', () => {
  it("puts D9's 19% VAT on top of the credit, rounded once to the millime", () => {
    expect(VAT_PERCENT).toBe(19);
    expect(vatOf(50000n, 19)).toBe(9500n); // 50.000 TND of credit costs 59.500
    expect(vatOf(50001n, 19)).toBe(9500n); // 9500.19
    expect(vatOf(50003n, 19)).toBe(9501n); // 9500.57
    expect(vatOf(50n, 19)).toBe(10n); // 9.5: half away from zero
    expect(CREDIT_LIMITS).toEqual({ min: 10n, max: 1_000_000n });
  });

  it('writes references a person reads and types without doubt: FF and two groups of four, no I, L, O, U, 0 or 1', () => {
    let n = 0;
    const counting = (max: number) => n++ % max;
    expect(newReference(counting)).toBe('FF-ABCD-EFGH');
    for (let i = 0; i < 200; i++) expect(newReference()).toMatch(REFERENCE);
    expect(new Set(Array.from({ length: 200 }, () => newReference())).size).toBe(200);
  });

  it('reads a reference as typed from a bank statement, and refuses what cannot be one', () => {
    expect(['FF-7KQ2-9MXA', 'ff-7kq2-9mxa', 'FF7KQ29MXA', ' ff 7kq2 9mxa '].map(normalizedReference)).toEqual(['FF-7KQ2-9MXA', 'FF-7KQ2-9MXA', 'FF-7KQ2-9MXA', 'FF-7KQ2-9MXA']);
    expect(['FF-7KQ2-9MX', 'GG-7KQ2-9MXA', 'FF-7KQ2-9MXO', 'FF-7KQ1-9MXA', ''].map(normalizedReference)).toEqual([null, null, null, null, null]);
  });

  it('takes a transfer that makes the total, with or without a share withheld at source', () => {
    expect(transferProblem(AMOUNTS, 59500n, 0n, 3, 'TND')).toBeNull();
    expect(transferProblem(AMOUNTS, 58608n, 892n, 3, 'TND')).toBeNull(); // 1.5% of 59.500 withheld
  });

  it('refuses one that does not add up, or withholds the whole credit, naming the amounts', () => {
    expect(transferProblem(AMOUNTS, 59400n, 0n, 3, 'TND')).toBe("received 59.400 TND and withheld 0.000 TND make 59.400 TND, not the pro-forma's 59.500 TND");
    expect(transferProblem(AMOUNTS, 59500n, 1n, 3, 'TND')).toBe("received 59.500 TND and withheld 0.001 TND make 59.501 TND, not the pro-forma's 59.500 TND");
    expect(transferProblem(AMOUNTS, 0n, 59500n, 3, 'TND')).toBe('received must be more than 0');
    expect(transferProblem(AMOUNTS, 59501n, -1n, 3, 'TND')).toBe('withheld must be 0 or more');
    expect(transferProblem(AMOUNTS, 9500n, 50000n, 3, 'TND')).toBe('withheld 50.000 TND must be less than the credit, 50.000 TND');
  });

  it("tells the owners the credit added, and the withheld share's to come with the certificate", () => {
    const facts = {
      account: { id: '000000000001', name: 'Tunis Labs' },
      reference: 'FF-7KQ2-9MXA',
      creditMinor: 50000n,
      receivedMinor: 58608n,
      withheldMinor: 892n,
      exponent: 3,
      currency: 'TND',
      consoleUrl: 'https://console.ff.example',
    };

    expect(transferMail(facts)).toEqual({
      subject: 'Your transfer was received: Tunis Labs',
      text: [
        'We received your transfer of 58.608 TND for the pro-forma FF-7KQ2-9MXA: 49.108 TND of credit was added to your account "Tunis Labs" (000000000001).',
        '',
        '0.892 TND was withheld at source: it is added to your credit when we receive the withholding certificate.',
        '',
        'Your balance: https://console.ff.example/billing',
      ].join('\n'),
    });
    expect(transferMail({ ...facts, receivedMinor: 59500n, withheldMinor: 0n }).text).not.toContain('withheld');
    expect(withholdingMail(facts)).toEqual({
      subject: 'The share withheld at source was added: Tunis Labs',
      text: [
        'We received the withholding certificate for your transfer for the pro-forma FF-7KQ2-9MXA: the 0.892 TND withheld at source was added to the credit of your account "Tunis Labs" (000000000001).',
        '',
        'Your balance: https://console.ff.example/billing',
      ].join('\n'),
    });
  });
});
