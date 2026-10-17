import { format } from 'date-fns';
import type { Account, AccountUpdate, NewAccount } from '../services/api';

/** The onboarding form, as typed. */
export interface AccountForm {
  name: string;
  useCase: string;
  country: string;
  taxId: string;
}

/** POST /accounts's body from the onboarding form: trimmed, without the optional fields left empty. */
export function newAccountBody(form: AccountForm): NewAccount {
  const body: NewAccount = { name: form.name.trim() };
  const useCase = form.useCase.trim();
  const country = form.country.trim().toUpperCase();
  const taxId = form.taxId.trim();
  if (useCase) body.useCase = useCase;
  if (country) body.country = country;
  if (taxId) body.taxId = taxId;
  return body;
}

/** PATCH /accounts/:id's body: only what changed. Emptying the tax ID removes it (null). */
export function accountUpdateBody(account: Pick<Account, 'name' | 'taxId'>, form: { name: string; taxId: string }): AccountUpdate {
  const update: AccountUpdate = {};
  const name = form.name.trim();
  const taxId = form.taxId.trim() || null;
  if (name !== account.name) update.name = name;
  if (taxId !== account.taxId) update.taxId = taxId;
  return update;
}

/** "17 Oct 2026, 14:05" in the browser's time zone, or "—" for none. */
export function formatWhen(iso: string | null | undefined): string {
  return iso ? format(new Date(iso), 'd MMM yyyy, HH:mm') : '—';
}
