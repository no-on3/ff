/**
 * L1: a message as SES v2's SendEmail takes it (ADR 0012): addresses with a
 * name or none, in lower case; simple content made into MIME, a subject in
 * another alphabet encoded, both bodies as alternatives, no Bcc in it, its
 * Message-ID the message's; headers the request may add, and those it may not;
 * a raw message's sender and recipients from its header, its Bcc taken out.
 */
import { addressesOf, composeSimple, headerOf, headerProblem, rawParties, returnPathOf, senderOf, withoutBcc } from './email-send';

const ID = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe("SendEmail's message (L1, ADR 0012)", () => {
  it('reads address lists as RFC 5322 writes them, a name with a comma in quotes, in lower case; and a sender as one address', () => {
    expect(addressesOf('"Ana, Shop" <Orders@Shop.TN>, b@c.tn, not an address')).toEqual(['orders@shop.tn', 'b@c.tn', null]);
    expect([senderOf('Boutique Ana <Orders@Shop.Example.TN>'), senderOf('a@b.tn, c@d.tn'), senderOf('nobody')]).toEqual(['orders@shop.example.tn', null, null]);
  });

  it('makes simple content MIME: its subject encoded, both bodies as alternatives, its Message-ID the message\'s, no Bcc', async () => {
    const message = (
      await composeSimple(
        { from: 'Boutique Ana <orders@shop.example.tn>', to: ['client@example.tn'], cc: ['copy@example.tn'], replyTo: ['help@shop.example.tn'], subject: 'Votre reçu n° 42', text: 'Merci', html: '<p>Merci</p>', headers: [{ name: 'X-Order', value: '42' }] },
        ID,
        'email.ffunc.cloud',
        new Date('2026-10-30T08:00:00Z'),
      )
    ).toString();
    const { fields } = headerOf(Buffer.from(message));
    const field = (name: string) => fields.find((one) => one.name === name)?.value;

    expect([field('from'), field('to'), field('cc'), field('reply-to'), field('message-id'), field('x-order'), field('bcc')]).toEqual([
      'Boutique Ana <orders@shop.example.tn>',
      'client@example.tn',
      'copy@example.tn',
      'help@shop.example.tn',
      `<${ID}@email.ffunc.cloud>`,
      '42',
      undefined,
    ]);
    expect(field('subject')).toBe('=?UTF-8?Q?Votre_re=C3=A7u_n=C2=B0_42?=');
    expect(field('date')).toBe('Fri, 30 Oct 2026 08:00:00 +0000');
    expect(field('content-type')).toMatch(/^multipart\/alternative; boundary=/);
    expect(message).toContain('<p>Merci</p>');
  });

  it("takes the request's own headers, not those SES writes itself", () => {
    expect(headerProblem('X-Campaign', 'autumn')).toBeNull();
    expect(headerProblem('List-Unsubscribe', '<https://shop.example.tn/unsubscribe>')).toBeNull();
    expect(headerProblem('From', 'someone@else.tn')).toBe('From is a header SES writes itself');
    expect(headerProblem('DKIM-Signature', 'v=1')).toBe('DKIM-Signature is a header SES writes itself');
    expect(headerProblem('X-Bad', 'one\r\nBcc: spy@example.tn')).toBe("X-Bad's value is one line of 870 characters at most");
    expect(headerProblem('Bad Name', 'x')).toBe('"Bad Name" is not a header\'s name');
  });

  it("reads a raw message's sender and recipients, and takes its Bcc out, wherever it is, folded or not", () => {
    const raw = Buffer.from(
      'From: Ana <orders@shop.example.tn>\r\nTo: a@example.tn,\r\n b@example.tn\r\nBcc: hidden@example.tn,\r\n\tother@example.tn\r\nSubject: Hi\r\n\r\nBcc: in the body stays\r\n',
    );

    expect(rawParties(raw)).toEqual({ from: 'Ana <orders@shop.example.tn>', to: ['a@example.tn', 'b@example.tn'], cc: [], bcc: ['hidden@example.tn', 'other@example.tn'] });
    expect(withoutBcc(raw).toString()).toBe('From: Ana <orders@shop.example.tn>\r\nTo: a@example.tn,\r\n b@example.tn\r\nSubject: Hi\r\n\r\nBcc: in the body stays\r\n');
    expect(withoutBcc(Buffer.from('From: a@b.tn\r\nBcc: c@d.tn\r\n\r\nbody')).toString()).toBe('From: a@b.tn\r\n\r\nbody');
    const none = Buffer.from('From: a@b.tn\r\n\r\nbody');
    expect(withoutBcc(none)).toBe(none);
  });

  it('gives a message a return path that names it', () => {
    expect(returnPathOf(ID, 'bounces.mail.shop.example.tn')).toBe(`b-${ID}@bounces.mail.shop.example.tn`);
  });
});
