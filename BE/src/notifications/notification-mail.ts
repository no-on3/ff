import type { Language } from '../mail/language';
import type { Mail } from '../mail/mail.service';

export interface TestFacts {
  account: { id: string; name: string };
  /** Who asked for it: a login's address, or "development mode". */
  requestedBy: string;
  consoleUrl: string;
}

/** The e-mail of a test notification, which each owner gets as they will get their alarms'. */
export function testMail({ account, requestedBy, consoleUrl }: TestFacts, language: Language): Omit<Mail, 'to'> {
  if (language === 'fr') {
    return {
      subject: `Notification de test de FF : ${account.name}`,
      text: [
        `Ceci est une notification de test pour votre compte « ${account.name} » (${account.id}), demandée par ${requestedBy}.`,
        'Les notifications de vos alarmes arriveront de la même façon.',
        '',
        `La console : ${consoleUrl}`,
      ].join('\n'),
    };
  }
  return {
    subject: `A test notification from FF: ${account.name}`,
    text: [
      `This is a test notification for your account "${account.name}" (${account.id}), asked for by ${requestedBy}.`,
      "Your alarms' notifications will come the same way.",
      '',
      `The console: ${consoleUrl}`,
    ].join('\n'),
  };
}
