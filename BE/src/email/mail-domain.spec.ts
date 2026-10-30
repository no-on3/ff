/**
 * L1: a customer's domain's mail through FF (ADR 0012): its DKIM key, RSA of
 * 2,048 bits under a selector of its own, whose record's public half checks
 * what its private half signs; the four records the domain publishes; and the
 * check of its records, which finds its key in a record split in strings and
 * its return path's MX in any case, and tells a DNS that fails, which proves
 * nothing, from one that has no record.
 */
import { createPublicKey, createSign, createVerify } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { DnsUnavailableError } from '../function-urls/domain-check';
import { MailResolver, NodeMailResolver, checkMailDomain, mailDomainRecords, newDkimKey } from './mail-domain';

const DKIM = 'ff0a1b2c3d._domainkey.shop.example.tn';
const RETURN_PATH = 'bounces.mail.shop.example.tn';

describe("a customer's domain's mail (L1, ADR 0012)", () => {
  afterEach(() => jest.restoreAllMocks());

  it("makes a DKIM key of 2,048 bits under a selector of its own, whose record's public half checks what its private half signs", async () => {
    const key = await newDkimKey();
    const publicKey = createPublicKey({ key: Buffer.from(key.publicKey, 'base64'), format: 'der', type: 'spki' });
    const signature = createSign('sha256').update('From: orders@shop.example.tn').sign(key.privateKeyPem);

    expect(key.selector).toMatch(/^ff[0-9a-f]{8}$/);
    expect(publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(createVerify('sha256').update('From: orders@shop.example.tn').verify(publicKey, signature)).toBe(true);
    expect((await newDkimKey()).selector).not.toBe(key.selector);
  });

  it("gives the four records a domain publishes: its DKIM key, its return path's MX and SPF, and a DMARC policy that only reports", () => {
    expect(mailDomainRecords('shop.example.tn', 'ff0a1b2c3d', 'MIIB', 'mail.ffunc.cloud')).toEqual([
      { purpose: 'DKIM', type: 'TXT', name: DKIM, value: 'v=DKIM1; k=rsa; p=MIIB' },
      { purpose: 'MAIL_FROM', type: 'MX', name: RETURN_PATH, value: '10 mail.ffunc.cloud' },
      { purpose: 'SPF', type: 'TXT', name: RETURN_PATH, value: 'v=spf1 a:mail.ffunc.cloud -all' },
      { purpose: 'DMARC', type: 'TXT', name: '_dmarc.shop.example.tn', value: 'v=DMARC1; p=none;' },
    ]);
  });

  describe('its check', () => {
    const dns = (txt: Record<string, string[]>, mx: Record<string, string[]> = {}): MailResolver => ({ txt: async (name) => txt[name] ?? [], mx: async (name) => mx[name] ?? [] });
    const check = (resolver: MailResolver) => checkMailDomain(resolver, 'shop.example.tn', 'ff0a1b2c3d', 'MIIBIjANBg', 'mail.ffunc.cloud');

    it('finds the key in its record with spaces in it, as a record split in strings has them, and the MX in any case', async () => {
      expect(await check(dns({ [DKIM]: ['v=DKIM1; k=rsa; p=MIIB IjAN Bg'] }, { [RETURN_PATH]: ['Mail.FFunc.Cloud.'] }))).toEqual({ dkim: true, mailFrom: true });
      expect(await check(dns({ [DKIM]: ['v=spf1 -all', 'v=DKIM1;p=MIIBIjANBg;t=s'] }))).toEqual({ dkim: true, mailFrom: false });
    });

    it('finds no proof in another key, a record at another name, or an MX elsewhere', async () => {
      expect(await check(dns({ [DKIM]: ['v=DKIM1; k=rsa; p=MIIBother'], 'other._domainkey.shop.example.tn': ['v=DKIM1; k=rsa; p=MIIBIjANBg'] }, { [RETURN_PATH]: ['mx.elsewhere.tn'] }))).toEqual({
        dkim: false,
        mailFrom: false,
      });
    });

    it("takes the DNS's no such record for none, its record's strings joined, and its failure for no answer at all", async () => {
      const resolver = new NodeMailResolver(['127.0.0.1']);
      jest.spyOn(Resolver.prototype, 'resolveTxt').mockResolvedValueOnce([['v=DKIM1; k=rsa; p=MII', 'BIjANBg']]);
      expect(await resolver.txt(DKIM)).toEqual(['v=DKIM1; k=rsa; p=MIIBIjANBg']);
      jest.spyOn(Resolver.prototype, 'resolveMx').mockRejectedValueOnce(Object.assign(new Error(`queryMx ENOTFOUND ${RETURN_PATH}`), { code: 'ENOTFOUND' }));
      expect(await resolver.mx(RETURN_PATH)).toEqual([]);
      jest.spyOn(Resolver.prototype, 'resolveMx').mockRejectedValueOnce(Object.assign(new Error(`queryMx ETIMEOUT ${RETURN_PATH}`), { code: 'ETIMEOUT' }));
      await expect(resolver.mx(RETURN_PATH)).rejects.toBeInstanceOf(DnsUnavailableError);
    });
  });
});
