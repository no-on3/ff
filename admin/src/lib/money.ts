/**
 * Money as the API writes it (P-31): a string with every decimal of its
 * currency, never a JSON number, so nothing here goes through a float.
 */

/** An amount to read, thousands apart: "12,500.000 TND", "-0.250 TND". As the console writes it. */
export function formatMoney(amount: string, currency: string): string {
  const [whole, fraction] = amount.replace(/^-/, '').split('.');
  const sign = amount.startsWith('-') ? '-' : '';
  return `${sign}${BigInt(whole).toLocaleString('en-US')}${fraction === undefined ? '' : `.${fraction}`} ${currency}`;
}

/** What a balance means, for the account page: below zero, usage the credit didn't cover. */
export const balanceNote = (amount: string): string => (amount.startsWith('-') ? 'Owed: usage beyond the credit' : 'Credit left');
