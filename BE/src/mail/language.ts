/**
 * The languages of the e-mails customers get: French, Tunisia's language of
 * business and every user's at first, or English for whoever chooses it.
 */
export type Language = 'fr' | 'en';

/** What a user may choose (users.locale): French with Tunisia's ways of writing amounts and dates, or English. */
export const LOCALES = ['fr-TN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** A user's locale as the language of their e-mails: English for an English one, French otherwise. */
export const languageOf = (locale: string | null | undefined): Language => (/^en(-|$)/i.test(locale ?? '') ? 'en' : 'fr');

/** Someone to write to, in their language. */
export interface Recipient {
  email: string;
  locale?: string | null;
}

/** An account's members as recipients: their login's address and language; one without a login has no address. */
export const recipientsOf = (members: Array<{ user?: { email: string; locale: string } | null }>): Recipient[] =>
  members.map(({ user }) => ({ email: user?.email ?? '', locale: user?.locale }));
