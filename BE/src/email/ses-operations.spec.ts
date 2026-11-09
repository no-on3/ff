/**
 * L1: SES v2's routes FF answers, and SendEmail's requests, each checked in
 * FF's order before the account's state is read (ADR 0012): refused, in SES's
 * status, error and words; or taken, its sender and its recipients, each once,
 * in lower case, as its envelope names them. The account's sending, its
 * identities and its suppression list are stand-ins that let any message by;
 * the last one stops it there, with the recipients it was given. Its cases are
 * send-email-examples.json's, which ff local's mail reads too.
 */
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CreditService } from '../billing/credit.service';
import { PlansService } from '../plans/plans.service';
import { EmailAccountService } from './email-account.service';
import { EmailIdentitiesService } from './email-identities.service';
import { EmailIdentityStatus, EmailIdentityType } from './email-identity.entity';
import { EmailMessagesService } from './email-messages.service';
import { EmailSender } from './email-sender.service';
import { EmailSuppressionsService } from './email-suppressions.service';
import { SesError } from './ses-error';
import { SesOperations, routeOf } from './ses-operations';

interface Refused {
  title: string;
  request: Record<string, unknown>;
  status: number;
  type: string;
  message: string;
}
interface Taken {
  title: string;
  request: Record<string, unknown>;
  from: string;
  recipients: string[];
}
const table = JSON.parse(readFileSync(join(__dirname, 'send-email-examples.json'), 'utf8')) as {
  routes: Array<{ method: string; path: string; operation: string | null; name?: string }>;
  requests: { refused: Refused[]; taken: Taken[] };
};

/** A case's request as a client sends it: `manyTo` made that many recipients, a raw message's text in base64. */
function sent(request: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(request)) as { Destination?: { manyTo?: number }; Content?: { Raw?: { message?: string } } };
  const many = copy.Destination?.manyTo;
  if (many !== undefined) copy.Destination = { ToAddresses: Array.from({ length: many }, (_, at) => `r${at + 1}@example.tn`) } as typeof copy.Destination;
  const raw = copy.Content?.Raw?.message;
  if (copy.Content && raw !== undefined) copy.Content.Raw = { Data: Buffer.from(raw).toString('base64') } as typeof copy.Content.Raw;
  return copy;
}

/** Where a message got to: its sender's identity looked up, and its recipients checked against the suppression list. */
class Reached extends Error {
  constructor(
    readonly from: string,
    readonly recipients: string[],
  ) {
    super('past the request and the account');
  }
}

describe("SES v2's routes, and SendEmail's requests (L1, ADR 0012)", () => {
  let from = '';
  const identities = {
    findAll: async (_: string, names: string[]) => {
      from = names[0];
      return new Map([[names[0], { identity: names[0], type: EmailIdentityType.EMAIL_ADDRESS, status: EmailIdentityStatus.SUCCESS }]]);
    },
  } as unknown as EmailIdentitiesService;
  const suppressions = {
    suppressedOf: async (_: string, recipients: string[]) => {
      throw new Reached(from, recipients);
    },
  } as unknown as EmailSuppressionsService;
  const account = { sendingOf: async () => ({ sendingEnabled: true, enforcementStatus: 'HEALTHY', productionAccess: true }) } as unknown as EmailAccountService;
  const config = new ConfigService({
    email: { mailHost: 'mail.ff.test', bounceDomain: 'bounces.mail.ff.test', domainResolvers: [], server: { smtpHost: 'mail.ff.test', smtpPort: 25, agentUrl: 'http://mail.ff.test', agentToken: 'token' } },
    ses: { base: 'http://email.localhost:3005', region: 'tn-tunis-1' },
  });
  const messages = new EmailMessagesService(
    {} as never,
    identities,
    suppressions,
    account,
    {} as unknown as PlansService,
    {} as unknown as EmailSender,
    { admit: async () => undefined } as unknown as CreditService,
    config,
  );
  const operations = new SesOperations(identities, suppressions, account, messages);
  const caller = { accountId: '810000000001', keyId: 'AKFFEXAMPLE', readOnly: false, actor: { id: 'access_key:AKFFEXAMPLE', label: 'access key AKFFEXAMPLE' } };
  const sendEmail = (request: Record<string, unknown>) => operations.run({ method: 'POST', path: '/v2/email/outbound-emails', query: new URLSearchParams(), input: sent(request) }, caller);

  it('answers each route by its method and path, a name in the path decoded, and none other', () => {
    for (const { method, path, operation, name } of table.routes) {
      const route = routeOf(method, path);
      expect([method, path, route?.operation ?? null, route?.name]).toEqual([method, path, operation, name]);
    }
  });

  it("refuses a request in SES's status, error and words, at the first of FF's checks it fails", async () => {
    for (const example of table.requests.refused) {
      const refusal = await sendEmail(example.request).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(SesError);
      const { status, type, message } = refusal as SesError;
      expect([example.title, status, type, message]).toEqual([example.title, example.status, example.type, example.message]);
    }
  });

  it('takes a request past its checks, its sender and its recipients, each once and in lower case, as its envelope names them', async () => {
    for (const example of table.requests.taken) {
      const reached = await sendEmail(example.request).then(
        () => null,
        (error: unknown) => error,
      );
      expect(reached).toBeInstanceOf(Reached);
      expect([example.title, (reached as Reached).from, (reached as Reached).recipients]).toEqual([example.title, example.from, example.recipients]);
    }
  });
});
