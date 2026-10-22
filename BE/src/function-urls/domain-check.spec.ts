import { DnsUnavailableError, DomainResolver, NodeDomainResolver, checkDomain, domainRecords } from './domain-check';
import { domainKey, domainProblem } from './domain-name';

const URL_HOST = '0123456789abcdefghijklmnopqrstuv.fn.example.tn';
const TOKEN = '4f1c2b3a5d6e7f8091a2b3c4d5e6f708';
const EDGE = ['203.0.113.10', '2001:db8::10'];

/** A resolver with the zone's records, by name. */
const zone = (records: { cname?: Record<string, string[]>; txt?: Record<string, string[]>; addresses?: Record<string, string[]> }): DomainResolver => ({
  cname: async (name) => records.cname?.[name] ?? [],
  txt: async (name) => records.txt?.[name] ?? [],
  addresses: async (name) => records.addresses?.[name] ?? [],
});

describe("a customer's domain, as an account may give it", () => {
  it('is kept in lower case, without a final dot', () => {
    expect(domainKey(' Shop.Example.TN. ')).toBe('shop.example.tn');
    expect(domainProblem('Shop.Example.TN.', 'fn.example.tn')).toBeNull();
    expect(domainProblem('example.tn', 'fn.example.tn')).toBeNull(); // an apex too
  });

  it.each([
    ['one label', 'localhost', 'A domain has two labels at least, such as example.tn'],
    ['an IP address', '192.0.2.1', 'An IP address is no domain: give a name, such as api.example.tn'],
    ['an IPv6 address', '[2001:db8::1]', 'An IP address is no domain: give a name, such as api.example.tn'],
    ['a label with an underscore', 'my_shop.example.tn', '"my_shop" is not a label: 1 to 63 letters, digits and hyphens, not starting or ending with a hyphen'],
    ['a label starting with a hyphen', '-shop.example.tn', '"-shop" is not a label: 1 to 63 letters, digits and hyphens, not starting or ending with a hyphen'],
    ['a label of 64 characters', `${'a'.repeat(64)}.example.tn`, `"${'a'.repeat(64)}" is not a label: 1 to 63 letters, digits and hyphens, not starting or ending with a hyphen`],
    ['a number for its last label', 'shop.example.123', 'A domain ends with a name, not a number'],
    ['the function domain', 'fn.example.tn', "fn.example.tn is under fn.example.tn, where FF's own URLs are"],
    ['a name under it', 'x.fn.example.tn', "x.fn.example.tn is under fn.example.tn, where FF's own URLs are"],
    ['a name no authority certifies', 'shop.local', 'shop.local is under .local, which no certificate authority certifies'],
    ['nothing', ' ', 'A domain has 1 to 253 characters'],
  ])('refuses %s', (_case, domain, problem) => {
    expect(domainProblem(domain, 'fn.example.tn')).toBe(problem);
  });

  it('takes names under .test in development, where a test zone has them', () => {
    expect(domainProblem('shop.example.test', 'fn.example.tn', { allowPrivate: true })).toBeNull();
  });
});

describe("the records a domain needs, and their check", () => {
  it('offers a CNAME to the URL, or the TXT record and the edge\'s addresses', () => {
    expect(domainRecords('shop.example.tn', URL_HOST, TOKEN, EDGE)).toEqual({
      cname: [{ type: 'CNAME', name: 'shop.example.tn', value: URL_HOST }],
      txt: [
        { type: 'TXT', name: '_ff-verify.shop.example.tn', value: `ff-verify=${TOKEN}` },
        { type: 'A', name: 'shop.example.tn', value: '203.0.113.10' },
        { type: 'AAAA', name: 'shop.example.tn', value: '2001:db8::10' },
      ],
    });
  });

  it("proves a subdomain by its CNAME to the URL's host, compared without case or final dot", async () => {
    const resolver = zone({ cname: { 'shop.example.tn': [`${URL_HOST.toUpperCase()}.`] } });

    expect(await checkDomain(resolver, 'shop.example.tn', URL_HOST, TOKEN, EDGE)).toEqual({ verified: true, by: 'CNAME' });
  });

  it("proves an apex by the TXT record with the token, and the edge's addresses", async () => {
    const resolver = zone({ txt: { '_ff-verify.example.tn': ['v=spf1 -all', `ff-verify=${TOKEN}`] }, addresses: { 'example.tn': EDGE } });

    expect(await checkDomain(resolver, 'example.tn', URL_HOST, TOKEN, EDGE)).toEqual({ verified: true, by: 'TXT' });
  });

  it('takes the TXT record alone where the settings name no edge address', async () => {
    const resolver = zone({ txt: { '_ff-verify.example.tn': [`ff-verify=${TOKEN}`] } });

    expect(await checkDomain(resolver, 'example.tn', URL_HOST, TOKEN, [])).toEqual({ verified: true, by: 'TXT' });
  });

  it.each([
    ['nothing', zone({}), `Neither a CNAME from example.tn to ${URL_HOST}, nor a TXT record at _ff-verify.example.tn with "ff-verify=${TOKEN}", was found`],
    ['a CNAME elsewhere', zone({ cname: { 'example.tn': ['shop.otherhost.example.'] } }), `example.tn is a CNAME to shop.otherhost.example, not to ${URL_HOST}`],
    ['another token', zone({ txt: { '_ff-verify.example.tn': ['ff-verify=another'] } }), `Neither a CNAME from example.tn to ${URL_HOST}, nor a TXT record at _ff-verify.example.tn with "ff-verify=${TOKEN}", was found`],
    ['the token without an address', zone({ txt: { '_ff-verify.example.tn': [`ff-verify=${TOKEN}`] } }), 'example.tn has the TXT record, and no address: point it to 203.0.113.10, 2001:db8::10'],
    [
      'the token with an address elsewhere too',
      zone({ txt: { '_ff-verify.example.tn': [`ff-verify=${TOKEN}`] }, addresses: { 'example.tn': ['203.0.113.10', '198.51.100.7'] } }),
      "example.tn points to 198.51.100.7, which is not FF's edge: point it to 203.0.113.10, 2001:db8::10 only",
    ],
  ])('says why it fails for %s', async (_case, resolver, problem) => {
    expect(await checkDomain(resolver, 'example.tn', URL_HOST, TOKEN, EDGE)).toEqual({ verified: false, problem });
  });
});

describe("the backend's resolver", () => {
  it('answers no record for a name that does not exist, and fails for a server that does not answer', async () => {
    // A server on a port nobody listens on: the questions fail, which proves nothing either way.
    const resolver = new NodeDomainResolver(['127.0.0.1:9']);

    await expect(resolver.cname('example.tn')).rejects.toBeInstanceOf(DnsUnavailableError);
  }, 20_000);
});
