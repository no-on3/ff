#!/usr/bin/env node
// AWS's SDK for JavaScript v3 against the spike's SES v2 endpoint, its endpoint from AWS_ENDPOINT_URL_SESV2 alone, as
// a function would have FF's in its environment: one JSON line a check, what was wanted and what came.
//   MODULES=<dir with @aws-sdk/client-sesv2> AWS_ENDPOINT_URL_SESV2=… KEY=… SECRET=… node ses-sdk-check.mjs
import { createRequire } from 'node:module';

const require = createRequire(`${process.env.MODULES}/`);
const ses = require('@aws-sdk/client-sesv2');
const { KEY, SECRET } = process.env;
const client = (secret = SECRET) => new ses.SESv2Client({ region: 'tn-tunis-1', credentials: { accessKeyId: KEY, secretAccessKey: secret } });
const sdk = client();

async function check(want, what, run) {
  let got;
  let detail = '';
  try {
    detail = JSON.stringify(await run()).slice(0, 200);
    got = 'ok';
  } catch (error) {
    got = error.name;
    detail = error.message;
  }
  console.log(JSON.stringify({ client: 'sdk-js', want, got, what, detail }));
}
const expect = (value, condition, problem) => {
  if (!condition) throw new Error(`${problem}: ${JSON.stringify(value)}`);
  return value;
};

await check('ok', 'CreateEmailIdentity of a domain answers its DKIM tokens', async () => {
  const out = await sdk.send(new ses.CreateEmailIdentityCommand({ EmailIdentity: 'shop.example' }));
  return expect(out, out.IdentityType === 'DOMAIN' && out.DkimAttributes?.Tokens?.[0] === 'ff1', 'no DKIM token');
});
await check('ok', 'CreateEmailIdentity of a verified domain, and of an address', async () => {
  await sdk.send(new ses.CreateEmailIdentityCommand({ EmailIdentity: 'verified.example' }));
  return sdk.send(new ses.CreateEmailIdentityCommand({ EmailIdentity: 'ana@client.example' }));
});
await check('AlreadyExistsException', 'CreateEmailIdentity of one already there', () => sdk.send(new ses.CreateEmailIdentityCommand({ EmailIdentity: 'shop.example' })));
await check('ok', "GetEmailIdentity of an address, whose @ is escaped in the path, and its key's time read as a date", async () => {
  const out = await sdk.send(new ses.GetEmailIdentityCommand({ EmailIdentity: 'ana@client.example' }));
  const domain = await sdk.send(new ses.GetEmailIdentityCommand({ EmailIdentity: 'shop.example' }));
  return expect(
    { address: out.IdentityType, key: domain.DkimAttributes?.LastKeyGenerationTimestamp?.toISOString?.() },
    out.IdentityType === 'EMAIL_ADDRESS' && domain.DkimAttributes?.LastKeyGenerationTimestamp instanceof Date,
    'not read',
  );
});
await check('NotFoundException', 'GetEmailIdentity of one not there', () => sdk.send(new ses.GetEmailIdentityCommand({ EmailIdentity: 'nowhere.example' })));
await check('ok', 'ListEmailIdentities, two pages of two', async () => {
  const first = await sdk.send(new ses.ListEmailIdentitiesCommand({ PageSize: 2 }));
  const second = await sdk.send(new ses.ListEmailIdentitiesCommand({ PageSize: 2, NextToken: first.NextToken }));
  return expect([...first.EmailIdentities, ...second.EmailIdentities].map((one) => one.IdentityName), first.EmailIdentities.length === 2 && second.EmailIdentities.length === 1, 'not three');
});
await check('ok', 'SendEmail, simple, from a verified domain', async () => {
  const out = await sdk.send(
    new ses.SendEmailCommand({
      FromEmailAddress: 'orders@verified.example',
      Destination: { ToAddresses: ['ana@client.example'], CcAddresses: ['bo@client.example'] },
      ReplyToAddresses: ['help@verified.example'],
      Content: { Simple: { Subject: { Data: 'Your receipt', Charset: 'UTF-8' }, Body: { Text: { Data: 'Thanks' }, Html: { Data: '<p>Thanks</p>' } } } },
    }),
  );
  return expect(out, typeof out.MessageId === 'string', 'no MessageId');
});
await check('ok', 'SendEmail, raw, its bytes as base64', () =>
  sdk.send(new ses.SendEmailCommand({ Content: { Raw: { Data: Buffer.from('From: orders@verified.example\r\nTo: ana@client.example\r\nSubject: raw\r\n\r\nhello\r\n') } } })),
);
await check('MessageRejected', 'SendEmail from a domain not verified', () =>
  sdk.send(new ses.SendEmailCommand({ FromEmailAddress: 'x@shop.example', Destination: { ToAddresses: ['a@b.example'] }, Content: { Simple: { Subject: { Data: 's' }, Body: { Text: { Data: 'b' } } } } })),
);
await check('ok', 'GetAccount: the quotas and the sandbox', async () => {
  const out = await sdk.send(new ses.GetAccountCommand({}));
  return expect(out.SendQuota, out.SendQuota?.Max24HourSend === 200 && out.ProductionAccessEnabled === false, 'no quota');
});
await check('ok', 'PutSuppressedDestination, then GetSuppressedDestination, its time a date', async () => {
  await sdk.send(new ses.PutSuppressedDestinationCommand({ EmailAddress: 'gone@client.example', Reason: 'BOUNCE' }));
  const out = await sdk.send(new ses.GetSuppressedDestinationCommand({ EmailAddress: 'gone@client.example' }));
  return expect(out.SuppressedDestination?.LastUpdateTime?.toISOString?.(), out.SuppressedDestination?.LastUpdateTime instanceof Date, 'not a date');
});
await check('ok', 'ListSuppressedDestinations by reason', async () => {
  const out = await sdk.send(new ses.ListSuppressedDestinationsCommand({ Reasons: ['BOUNCE'] }));
  return expect(out.SuppressedDestinationSummaries?.length, out.SuppressedDestinationSummaries?.length === 1, 'not one');
});
await check('ok', 'DeleteSuppressedDestination, then DeleteEmailIdentity', async () => {
  await sdk.send(new ses.DeleteSuppressedDestinationCommand({ EmailAddress: 'gone@client.example' }));
  return sdk.send(new ses.DeleteEmailIdentityCommand({ EmailIdentity: 'shop.example' }));
});
await check('SignatureDoesNotMatch', 'a wrong secret', () => client('wrong-secret-wrong-secret-wrong-secret00').send(new ses.GetAccountCommand({})));
