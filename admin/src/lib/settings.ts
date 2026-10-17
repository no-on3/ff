/** The platform's settings (P-70, D12), as GET /admin/settings gives them. contract.test.ts checks the keys against the API's. */
export interface PlatformSettings {
  billingShadowMode: boolean;
  negativeBuffer: string;
  gracePeriodHours: number;
  lowBalancePercents: number[];
  invoiceReminderDay: number;
  largeCreditThreshold: string;
}
export type SettingKey = keyof PlatformSettings;

type Kind = 'boolean' | 'whole' | 'dinars' | 'percents';
export interface SettingInfo {
  key: SettingKey;
  label: string;
  /** What it does, and which task reads it. */
  help: string;
  kind: Kind;
  /** Unit or bounds, shown next to the input. */
  unit?: string;
}

export const SETTINGS: SettingInfo[] = [
  { key: 'billingShadowMode', label: 'Shadow billing', kind: 'boolean', help: 'Usage is rated and shown, but nothing is debited (D9; from P-32).' },
  { key: 'negativeBuffer', label: 'Negative buffer', kind: 'dinars', unit: 'TND', help: 'How far below zero a balance may go before invokes stop (D9; from P-33).' },
  { key: 'gracePeriodHours', label: 'Grace period', kind: 'whole', unit: 'hours, 0 to 720', help: 'After the buffer runs out, invokes answer 402 once this has passed (D9; from P-33).' },
  { key: 'lowBalancePercents', label: 'Low-balance e-mails', kind: 'percents', unit: '% of the last top-up, largest first', help: 'For owners who set none (from P-33).' },
  { key: 'invoiceReminderDay', label: 'Invoice reminder', kind: 'whole', unit: 'day of the month, 1 to 28', help: 'A reminder when the monthly invoices aren’t issued by then (D9; from P-36).' },
  { key: 'largeCreditThreshold', label: 'Large credit', kind: 'dinars', unit: 'TND', help: 'A credit grant above this needs a second confirmation (D12; from P-74).' },
];

/** A setting as its input shows it. */
export function formatSetting(kind: Kind, value: unknown): string {
  if (kind === 'percents') return (value as number[]).join(', ');
  return String(value);
}

/** A setting to read: on or off, percentages with commas, the rest as it is. */
export function describeSetting(kind: Kind, value: unknown): string {
  return kind === 'boolean' ? (value ? 'on' : 'off') : formatSetting(kind, value);
}

/** An input's text as the setting's value, or why it isn't one. The API checks the bounds again. */
export function parseSetting(kind: Kind, text: string): { value: unknown } | { problem: string } {
  const trimmed = text.trim();
  switch (kind) {
    case 'boolean':
      return trimmed === 'true' || trimmed === 'false' ? { value: trimmed === 'true' } : { problem: 'must be on or off' };
    case 'whole':
      return /^\d+$/.test(trimmed) ? { value: Number(trimmed) } : { problem: 'must be a whole number' };
    case 'dinars':
      return /^\d{1,9}\.\d{3}$/.test(trimmed) ? { value: trimmed } : { problem: 'must be an amount in TND with three decimals, such as 5.000' };
    case 'percents': {
      if (trimmed === '') return { value: [] };
      const parts = trimmed.split(/\s*,\s*/);
      return parts.every((part) => /^\d+$/.test(part))
        ? { value: parts.map(Number) }
        : { problem: 'must be whole percentages, separated by commas, such as 50, 20, 0' };
    }
  }
}

/** The form's settings that differ from the current ones: what a save sends. A problem stops the save. */
export function changedSettings(
  form: Record<SettingKey, string>,
  current: PlatformSettings,
): { changes: Partial<PlatformSettings>; problems: string[] } {
  const changes: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const { key, kind, label } of SETTINGS) {
    const parsed = parseSetting(kind, form[key]);
    if ('problem' in parsed) problems.push(`${label}: ${parsed.problem}`);
    else if (JSON.stringify(parsed.value) !== JSON.stringify(current[key])) changes[key] = parsed.value;
  }
  return { changes: changes as Partial<PlatformSettings>, problems };
}

/** The form's starting text: each setting's current value. */
export const formOf = (settings: PlatformSettings): Record<SettingKey, string> =>
  Object.fromEntries(SETTINGS.map(({ key, kind }) => [key, formatSetting(kind, settings[key])])) as Record<SettingKey, string>;
