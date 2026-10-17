import { z } from 'zod';

/** A sum of dinars, with the three places of the millime: "5.000". */
const dinars = z.string().regex(/^\d{1,9}\.\d{3}$/, 'must be an amount in TND with three decimals, such as 5.000');

/** Shares of the last credit for the low-balance e-mails (P-33), in percent: from the largest to the smallest, each once, five at most. */
export const lowBalancePercentsSchema = z
  .array(z.number().int().min(0).max(100))
  .max(5)
  .refine((percents) => percents.every((percent, index) => index === 0 || percent < percents[index - 1]), {
    message: 'must go from the largest share to the smallest, each once',
  });

/**
 * The settings FF's operators change from the admin dashboard rather than in
 * environment variables (D12): kept in platform_settings, each change in the
 * audit log with its reason. Each says which task reads it; the defaults are
 * starting values, which those tasks may revisit.
 */
export const platformSettingsSchema = z.strictObject({
  /** D9, P-32: hourly rating runs and is shown to customers, but debits nothing. */
  billingShadowMode: z.boolean(),
  /** D9, P-33: how far below zero a balance may go before invokes stop, in TND. */
  negativeBuffer: dinars,
  /** D9, P-33: hours after the buffer runs out before invokes answer 402. */
  gracePeriodHours: z.number().int().min(0).max(720),
  /** P-33: the low-balance e-mails, at these shares of the last credit, for owners who set none. Largest first. */
  lowBalancePercents: lowBalancePercentsSchema,
  /** D9, P-36: the day of the month by which the monthly invoices are issued; a reminder after it. */
  invoiceReminderDay: z.number().int().min(1).max(28),
  /** D12, P-74: a credit grant above this, in TND, needs a second confirmation. */
  largeCreditThreshold: dinars,
});

export type PlatformSettings = z.infer<typeof platformSettingsSchema>;
export type SettingKey = keyof PlatformSettings;

export const DEFAULT_SETTINGS: PlatformSettings = {
  billingShadowMode: true,
  negativeBuffer: '1.000',
  gracePeriodHours: 24,
  lowBalancePercents: [50, 20, 0],
  invoiceReminderDay: 3,
  largeCreditThreshold: '100.000',
};

export const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS) as SettingKey[];

/** Where a value doesn't fit, as "key: why", one problem per line. */
export function settingProblems(error: z.ZodError): string[] {
  return error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message));
}
