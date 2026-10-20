import type { Mail } from './mail.service';
import { MailService } from './mail.service';

/**
 * For tests: a MailService that sends nothing and pushes each e-mail to
 * `sent`, with the real sendEach, so that each recipient's language is
 * chosen as in production.
 */
export function capturingMail(sent: Mail[]): MailService {
  const mail = Object.create(MailService.prototype) as MailService;
  return Object.assign(mail, { send: (message: Mail) => Promise.resolve(sent.push(message) > 0) });
}
