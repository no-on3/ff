import { DEFAULT_SETTINGS, SETTING_KEYS, platformSettingsSchema, settingProblems } from './platform-settings';

const problems = (value: unknown) => {
  const parsed = platformSettingsSchema.partial().safeParse(value);
  return parsed.success ? [] : settingProblems(parsed.error);
};

describe('the platform settings (P-70, D12)', () => {
  it('start from defaults that fit their own rules', () => {
    expect(platformSettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
    expect(SETTING_KEYS).toEqual([
      'billingShadowMode',
      'negativeBuffer',
      'gracePeriodHours',
      'lowBalancePercents',
      'invoiceReminderDay',
      'largeCreditThreshold',
      'closedAccountDeletionDays',
    ]);
  });

  it('take any of them on its own', () => {
    expect(problems({ gracePeriodHours: 48 })).toEqual([]);
    expect(problems({ negativeBuffer: '12.500', largeCreditThreshold: '0.000' })).toEqual([]);
    expect(problems({})).toEqual([]);
    expect([problems({ closedAccountDeletionDays: 1 }), problems({ closedAccountDeletionDays: 365 })]).toEqual([[], []]);
  });

  it.each([
    [{ billingShadowMode: 'yes' }, 'billingShadowMode: Invalid input: expected boolean, received string'],
    [{ negativeBuffer: '5' }, 'negativeBuffer: must be an amount in TND with three decimals, such as 5.000'],
    [{ negativeBuffer: '-1.000' }, 'negativeBuffer: must be an amount in TND with three decimals, such as 5.000'],
    [{ gracePeriodHours: 1.5 }, 'gracePeriodHours: Invalid input: expected int, received number'],
    [{ gracePeriodHours: 721 }, 'gracePeriodHours: Too big: expected number to be <=720'],
    [{ invoiceReminderDay: 31 }, 'invoiceReminderDay: Too big: expected number to be <=28'],
    [{ lowBalancePercents: [20, 50] }, 'lowBalancePercents: must go from the largest share to the smallest, each once'],
    [{ lowBalancePercents: [50, 50] }, 'lowBalancePercents: must go from the largest share to the smallest, each once'],
    [{ lowBalancePercents: [101] }, 'lowBalancePercents.0: Too big: expected number to be <=100'],
    [{ closedAccountDeletionDays: 0 }, 'closedAccountDeletionDays: Too small: expected number to be >=1'],
    [{ closedAccountDeletionDays: 366 }, 'closedAccountDeletionDays: Too big: expected number to be <=365'],
    [{ closedAccountDeletionDays: 7.5 }, 'closedAccountDeletionDays: Invalid input: expected int, received number'],
    [{ invoicePrefix: 'FF' }, 'Unrecognized key: "invoicePrefix"'],
  ])('refuse %j, naming the setting: %s', (change, problem) => {
    expect(problems(change)).toEqual([problem]);
  });
});
