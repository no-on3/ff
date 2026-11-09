/**
 * L1: a message as SES v2's SendEmail takes it (ADR 0012): addresses with a
 * name or none, in lower case; simple content made into MIME, a subject in
 * another alphabet encoded, both bodies as alternatives, no Bcc in it, its
 * Message-ID the message's; headers the request may add, and those it may not;
 * a raw message's sender and recipients from its header, its Bcc taken out;
 * what its attachments weigh, as SES bills them. Its cases are
 * send-email-examples.json's, which ff local's mail reads too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { addressesOf, attachmentBytesOf, composeSimple, headerOf, headerProblem, mimeParts, rawParties, returnPathOf, senderOf, withoutBcc } from './email-send';

const ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const HOST = 'email.ffunc.cloud';

interface Composed {
  title: string;
  content: { from: string; to: string[]; cc: string[]; replyTo: string[]; subject: string; text?: string; html?: string; headers: Array<{ name: string; value: string }> };
  at: string;
  fields: Record<string, string>;
  absent: string[];
  type: string;
  parts: Array<{ type: string; body: string }>;
  written: Record<string, string>;
}
const table = JSON.parse(readFileSync(join(__dirname, 'send-email-examples.json'), 'utf8')) as {
  addresses: Array<{ list: string; addresses: Array<string | null> }>;
  senders: Array<{ text: string; sender: string | null }>;
  headers: Array<{ name: string; value: string; problem: string | null }>;
  raw: Array<{ message: string; parties: ReturnType<typeof rawParties>; withoutBcc: string }>;
  composed: Composed[];
};

/** A header field's value as a reader shows it: RFC 2047's encoded words decoded, the space between two of them dropped. */
const decodedWords = (value: string): string =>
  value
    .replace(/(\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_, encoding: string, text: string) =>
      (encoding.toUpperCase() === 'B' ? Buffer.from(text, 'base64') : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (__, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1')).toString('utf8'),
    );

/** A part's body as a reader shows it: its transfer encoding undone. */
function decodedBody(fields: Array<{ name: string; value: string }>, body: Buffer): string {
  const encoding = fields.find((field) => field.name === 'content-transfer-encoding')?.value.toLowerCase();
  if (encoding === 'base64') return Buffer.from(body.toString('latin1'), 'base64').toString('utf8');
  if (encoding === 'quoted-printable') {
    const text = body.toString('latin1').replace(/=\r?\n/g, '');
    return Buffer.from(text.replace(/=([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))), 'latin1').toString('utf8');
  }
  return body.toString('utf8');
}

/** A message as a reader shows it: its fields decoded, by their names in lower case, its type, and its parts' types and bodies. */
function readMessage(message: Buffer): { fields: Record<string, string>; type: string; parts: Array<{ type: string; body: string }> } {
  const { fields, end } = headerOf(message);
  const typeOf = (all: Array<{ name: string; value: string }>) => (all.find((field) => field.name === 'content-type')?.value ?? 'text/plain').split(';')[0].trim().toLowerCase();
  const parts = mimeParts(message);
  return {
    fields: Object.fromEntries(fields.map((field) => [field.name, decodedWords(field.value)])),
    type: typeOf(fields),
    parts: (parts.length > 0 ? parts : [{ fields, body: message.subarray(end) }]).map((part) => ({ type: typeOf(part.fields), body: decodedBody(part.fields, part.body) })),
  };
}

describe("SendEmail's message (L1, ADR 0012)", () => {
  it('reads address lists as RFC 5322 writes them, a name with a comma in quotes, in lower case; and a sender as one address', () => {
    for (const { list, addresses } of table.addresses) expect([list, addressesOf(list)]).toEqual([list, addresses]);
    for (const { text, sender } of table.senders) expect([text, senderOf(text)]).toEqual([text, sender]);
  });

  it('makes simple content MIME: its subject encoded, both bodies as alternatives, its Message-ID the message\'s, no Bcc', async () => {
    for (const example of table.composed) {
      const message = await composeSimple(example.content, ID, HOST, new Date(example.at));
      const read = readMessage(message);
      const { fields } = headerOf(message);
      const placed = (value: string) => value.replace('{id}', ID).replace('{host}', HOST);

      expect([example.title, Object.fromEntries(Object.keys(example.fields).map((name) => [name, read.fields[name]]))]).toEqual([
        example.title,
        Object.fromEntries(Object.entries(example.fields).map(([name, value]) => [name, placed(value)])),
      ]);
      expect([example.title, example.absent.filter((name) => name in read.fields)]).toEqual([example.title, []]);
      expect([example.title, read.type, read.parts]).toEqual([example.title, example.type, example.parts]);
      for (const [name, value] of Object.entries(example.written)) expect([example.title, fields.find((field) => field.name === name)?.value]).toEqual([example.title, value]);
    }
  });

  it("takes the request's own headers, not those SES writes itself", () => {
    for (const { name, value, problem } of table.headers) expect([name, headerProblem(name, value)]).toEqual([name, problem]);
  });

  it("reads a raw message's sender and recipients, and takes its Bcc out, wherever it is, folded or not", () => {
    for (const example of table.raw) {
      const raw = Buffer.from(example.message);
      expect([example.message, rawParties(raw)]).toEqual([example.message, example.parties]);
      expect([example.message, withoutBcc(raw).toString()]).toEqual([example.message, example.withoutBcc]);
      // A message without a Bcc is the one that came, not a copy.
      if (example.withoutBcc === example.message) expect(withoutBcc(raw)).toBe(raw);
    }
  });

  it('gives a message a return path that names it', () => {
    expect(returnPathOf(ID, 'bounces.mail.shop.example.tn')).toBe(`b-${ID}@bounces.mail.shop.example.tn`);
  });

  it("weighs a message's attachments as sent, nested ones and files named as RFC 2231 writes them, and nothing else", async () => {
    const raw = [
      'From: orders@shop.example.tn',
      'To: client@example.tn',
      'Subject: Receipt',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="outer"',
      '',
      '--outer',
      'Content-Type: multipart/alternative; boundary="inner"',
      '',
      '--inner',
      'Content-Type: text/plain',
      '',
      'Thank you.',
      '--inner',
      'Content-Type: text/html',
      '',
      '<p>Thank you.</p>',
      '--inner--',
      '--outer',
      'Content-Type: application/pdf; name="receipt.pdf"',
      'Content-Disposition: attachment; filename="receipt.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      'JVBERi0xLjQK',
      '--outer',
      'Content-Type: image/png',
      "Content-Disposition: inline; filename*=UTF-8''logo%20v2.png",
      'Content-Transfer-Encoding: base64',
      '',
      'iVBORw0KGgo=',
      '--outer--',
      '',
    ].join('\r\n');
    const simple = await composeSimple({ from: 'orders@shop.example.tn', to: ['client@example.tn'], cc: [], replyTo: [], subject: 'Hello', text: 'Merci', html: '<p>Merci</p>', headers: [] }, ID, HOST);

    expect(attachmentBytesOf(Buffer.from(raw))).toBe('JVBERi0xLjQK'.length + 'iVBORw0KGgo='.length);
    expect([attachmentBytesOf(simple), attachmentBytesOf(Buffer.from('Subject: Hello\r\n\r\nNo parts at all'))]).toEqual([0, 0]);
  });
});
