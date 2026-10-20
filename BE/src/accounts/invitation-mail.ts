import { frenchDate } from '../common/french';
import type { Role } from '../auth/principal';
import type { Language } from '../mail/language';
import type { Mail } from '../mail/mail.service';

export interface InvitationFacts {
  inviter: { email: string; name: string | null };
  account: { name: string };
  role: Role;
  expiresAt: Date;
  consoleUrl: string;
}

const FRENCH_ROLES: Record<Role, string> = { owner: 'propriétaire', developer: 'développeur', viewer: 'lecteur' };

/** The e-mail an invitation sends: who invites, to which account and as what, and how to join before it expires. */
export function invitationMail({ inviter, account, role, expiresAt, consoleUrl }: InvitationFacts, language: Language): Omit<Mail, 'to'> {
  if (language === 'fr') {
    return {
      subject: `${inviter.email} vous invite sur le compte FF « ${account.name} »`,
      text: [
        `${inviter.name ?? inviter.email} vous invite à rejoindre le compte FF « ${account.name} » en tant que ${FRENCH_ROLES[role]}.`,
        '',
        `Connectez-vous à la console FF avec cette adresse avant le ${frenchDate(expiresAt)} pour le rejoindre : ${consoleUrl}`,
        "Si vous n'avez pas encore d'identifiant, inscrivez-vous-y avec cette adresse.",
        '',
        "Si vous n'attendiez pas cet e-mail, ignorez-le : rien ne se passe tant que vous ne vous connectez pas.",
      ].join('\n'),
    };
  }
  return {
    subject: `${inviter.email} invited you to the FF account "${account.name}"`,
    text: [
      `${inviter.name ?? inviter.email} invited you to join the FF account "${account.name}" as ${role}.`,
      '',
      `Log in to the FF console with this address before ${expiresAt.toISOString().slice(0, 10)} to join: ${consoleUrl}`,
      'Without a login yet, sign up there with this address.',
      '',
      "If you didn't expect this e-mail, ignore it: nothing happens until you log in.",
    ].join('\n'),
  };
}
