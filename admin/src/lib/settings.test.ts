import { describe, expect, it } from 'vitest';
import { PlatformSettings, changedSettings, describeSetting, formOf, parseSetting } from './settings';

const CURRENT: PlatformSettings = {
  billingShadowMode: true,
  negativeBuffer: '1.000',
  gracePeriodHours: 24,
  lowBalancePercents: [50, 20, 0],
  invoiceReminderDay: 3,
  largeCreditThreshold: '100.000',
  closedAccountDeletionDays: 30,
};

describe('parseSetting', () => {
  it.each([
    ['boolean', 'false', false],
    ['whole', ' 48 ', 48],
    ['dinars', '12.500', '12.500'],
    ['percents', '50, 20,0', [50, 20, 0]],
    ['percents', '', []],
  ] as const)('reads a %s input %j as %j', (kind, text, value) => {
    expect(parseSetting(kind, text)).toEqual({ value });
  });

  it.each([
    ['whole', '1.5', 'must be a whole number'],
    ['whole', '-1', 'must be a whole number'],
    ['dinars', '12.5', 'must be an amount in TND with three decimals, such as 5.000'],
    ['percents', '50; 20', 'must be whole percentages, separated by commas, such as 50, 20, 0'],
  ] as const)('refuses a %s input %j: %s', (kind, text, problem) => {
    expect(parseSetting(kind, text)).toEqual({ problem });
  });
});

describe('describeSetting', () => {
  it('reads a switch as on or off, and percentages with commas', () => {
    expect([describeSetting('boolean', true), describeSetting('boolean', false), describeSetting('percents', [50, 20, 0]), describeSetting('dinars', '1.000')]).toEqual([
      'on',
      'off',
      '50, 20, 0',
      '1.000',
    ]);
  });
});

describe('changedSettings', () => {
  it('sends only what the form changed', () => {
    const form = { ...formOf(CURRENT), gracePeriodHours: '48', lowBalancePercents: '30, 0' };

    expect(changedSettings(form, CURRENT)).toEqual({ changes: { gracePeriodHours: 48, lowBalancePercents: [30, 0] }, problems: [] });
  });

  it('sends nothing for an unchanged form, even retyped', () => {
    expect(changedSettings({ ...formOf(CURRENT), lowBalancePercents: '50,20, 0' }, CURRENT)).toEqual({ changes: {}, problems: [] });
  });

  it('names each input that is not a value, by its label', () => {
    const form = { ...formOf(CURRENT), negativeBuffer: '1', invoiceReminderDay: 'third' };

    expect(changedSettings(form, CURRENT).problems).toEqual([
      'Negative buffer: must be an amount in TND with three decimals, such as 5.000',
      'Invoice reminder: must be a whole number',
    ]);
  });
});
