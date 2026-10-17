import { describe, expect, it } from 'vitest';
import { AdminPayment, canRecord, certificateDue, certificateName, certificateProblem, paymentState, transferOutcome } from './payments';

const PENDING: AdminPayment = {
  id: '7d0b8a3e-9a51-4c7e-8d5f-1b2c3d4e5f60',
  reference: 'FF-7KQ2-9MXA',
  status: 'pending',
  currency: 'TND',
  credit: '50.000',
  vatPercent: 19,
  vat: '9.500',
  total: '59.500',
  createdAt: '2026-10-17T09:30:00.000Z',
  buyer: { name: 'Tunis Labs', taxId: null },
  seller: { name: 'FF', taxId: '0000000/A/A/M/000', address: 'Tunis, Tunisia' },
  bank: { name: 'A bank', iban: 'TN59 1000 6035 1835 9847 8831', bic: null },
  transfer: null,
  cancelledAt: null,
  accountId: '000000000001',
  requestedBy: 'user:1',
  bankReference: null,
  recordedBy: null,
  certificateType: null,
  cancelledBy: null,
};
const TRANSFER = { received: '58.608', withheld: '0.892', receivedOn: '2026-10-20', recordedAt: '2026-10-21T08:00:00.000Z', credited: '49.108', withheldCreditedAt: null };
const PAID: AdminPayment = { ...PENDING, status: 'paid', transfer: TRANSFER, recordedBy: 'operator:kc-op-1' };

describe('recording a transfer (P-35)', () => {
  it('says what the wallet gets: the credit at once, or less the share withheld at source, which the certificate adds', () => {
    expect(transferOutcome(PENDING, '59.500', '0')).toEqual({ now: '50.000 TND', later: null });
    expect(transferOutcome(PENDING, '59.5', '')).toEqual({ now: '50.000 TND', later: null }); // nothing withheld
    expect(transferOutcome(PENDING, ' 58.608 ', '0.892')).toEqual({ now: '49.108 TND', later: '0.892 TND' });
  });

  it("refuses, as the API would, what doesn't make the total, or withholds the whole credit", () => {
    expect(transferOutcome(PENDING, '59.400', '0')).toEqual({ problem: "received 59.400 TND and withheld 0.000 TND make 59.400 TND, not the pro-forma's 59.500 TND" });
    expect(transferOutcome(PENDING, '59.500', '0.001')).toEqual({ problem: "received 59.500 TND and withheld 0.001 TND make 59.501 TND, not the pro-forma's 59.500 TND" });
    expect(transferOutcome(PENDING, '9.500', '50')).toEqual({ problem: 'withheld 50.000 TND must be less than the credit, 50.000 TND' });
    expect(transferOutcome(PENDING, '0', '59.500')).toEqual({ problem: 'received must be more than 0' });
  });

  it('refuses what is not an amount in the currency', () => {
    expect(transferOutcome(PENDING, '59,500', '0')).toEqual({ problem: 'received must be an amount, such as 59.500' });
    expect(transferOutcome(PENDING, '59.500', '-1')).toEqual({ problem: 'withheld must be an amount, such as 0.892, or 0' });
    expect(transferOutcome(PENDING, '59.5000', '0')).toEqual({ problem: 'TND has 3 decimals at most' });
  });
});

describe('the withholding certificate (P-35)', () => {
  it('takes a PDF, a PNG or a JPEG of 5 MB at most, as the API does', () => {
    expect(certificateProblem({ type: 'application/pdf', size: 1 })).toBeNull();
    expect(certificateProblem({ type: 'image/jpeg', size: 5 * 1024 * 1024 })).toBeNull();
    expect(certificateProblem({ type: 'image/png', size: 5 * 1024 * 1024 + 1 })).toBe('A certificate is 5 MB at most');
    expect(certificateProblem({ type: 'application/pdf', size: 0 })).toBe('The file is empty');
    expect(certificateProblem({ type: 'text/plain', size: 10 })).toBe('A certificate is a PDF, a PNG or a JPEG, not text/plain');
    expect(certificateProblem({ type: '', size: 10 })).toBe('A certificate is a PDF, a PNG or a JPEG, not a file of unknown type');
  });

  it('is due once a transfer with a share withheld is recorded, until it is added', () => {
    expect([PENDING, PAID, { ...PAID, certificateType: 'application/pdf' }].map(certificateDue)).toEqual([false, true, false]);
    expect(certificateDue({ ...PAID, transfer: { ...TRANSFER, received: '59.500', withheld: '0.000', credited: '50.000' } })).toBe(false);
  });

  it('downloads under the name the API gives it', () => {
    expect(['application/pdf', 'image/png', 'image/jpeg'].map((certificateType) => certificateName({ reference: 'FF-7KQ2-9MXA', certificateType }))).toEqual([
      'withholding-FF-7KQ2-9MXA.pdf',
      'withholding-FF-7KQ2-9MXA.png',
      'withholding-FF-7KQ2-9MXA.jpg',
    ]);
  });
});

describe("a payment's state (P-35)", () => {
  it('waits for the transfer, then says when it came, the credit it added, and the certificate', () => {
    expect(paymentState(PENDING)).toEqual({ label: 'Waiting for the transfer', note: null });
    expect(paymentState(PAID)).toEqual({ label: 'Received 2026-10-20: 49.108 TND credited', note: '0.892 TND withheld: certificate to add' });
    expect(paymentState({ ...PAID, certificateType: 'image/png', transfer: { ...TRANSFER, withheldCreditedAt: '2026-10-23T14:00:00.000Z' } }).note).toBe(
      '0.892 TND withheld: certificate added 2026-10-23 14:00:00 UTC',
    );
    expect(paymentState({ ...PAID, transfer: { ...TRANSFER, received: '59.500', withheld: '0.000', credited: '50.000' } })).toEqual({
      label: 'Received 2026-10-20: 50.000 TND credited',
      note: null,
    });
  });

  it('says when it was cancelled and by whom, and that a transfer that comes anyway can be recorded; paid anyway, it says so (P-74)', () => {
    const byOwner: AdminPayment = { ...PENDING, status: 'cancelled', cancelledAt: '2026-10-18T07:30:00.000Z', cancelledBy: 'user:1' };
    const byFf: AdminPayment = { ...byOwner, cancelledBy: 'operator:kc-op-1' };

    expect(paymentState(byOwner)).toEqual({ label: 'Cancelled 2026-10-18 07:30:00 UTC', note: 'by its owner; a transfer that comes anyway can still be recorded' });
    expect(paymentState(byFf).note).toBe('by FF; a transfer that comes anyway can still be recorded');
    expect(paymentState({ ...byFf, status: 'paid', transfer: TRANSFER })).toEqual({
      label: 'Received 2026-10-20: 49.108 TND credited',
      note: '0.892 TND withheld: certificate to add; it had been cancelled by FF 2026-10-18 07:30:00 UTC',
    });
    expect([canRecord(PENDING), canRecord(byOwner), canRecord(PAID)]).toEqual([true, true, false]);
  });
});
