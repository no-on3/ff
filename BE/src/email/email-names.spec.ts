/**
 * L1: the names customers' mail takes (ADR 0012): an identity kept trimmed and
 * in lower case, a domain without its final dot; a domain of two labels at
 * least, of letters, digits and hyphens, never an IP address; an address of a
 * local part as mailbox providers take one, at such a domain.
 */
import { EmailIdentityType } from './email-identity.entity';
import { addressProblem, domainOf, identityKey, identityOf, mailDomainProblem } from './email-names';

describe("customers' mail's names (L1, ADR 0012)", () => {
  it('keeps an identity trimmed and in lower case, a domain without its final dot', () => {
    expect([identityKey('  Shop.Example.TN. '), identityKey('Orders@Shop.Example.TN')]).toEqual(['shop.example.tn', 'orders@shop.example.tn']);
  });

  it('tells a domain from an address, and says why a name is neither', () => {
    expect(identityOf('Shop.Example.TN.')).toEqual({ identity: 'shop.example.tn', type: EmailIdentityType.DOMAIN });
    expect(identityOf(' Orders@Shop.Example.TN')).toEqual({ identity: 'orders@shop.example.tn', type: EmailIdentityType.EMAIL_ADDRESS });
    expect(identityOf('localhost')).toEqual({ problem: 'A domain has two labels at least, such as example.tn' });
    expect(identityOf('@example.tn')).toEqual({ problem: 'An address is a local part, @ and a domain, such as orders@example.tn' });
  });

  it("takes a domain of labels of letters, digits and hyphens, and refuses an IP address, a number at its end, a hyphen at a label's ends", () => {
    expect(['example.tn', 'mail-1.shop.example.tn', 'xn--mxa.example.tn', `${'a'.repeat(63)}.tn`].map(mailDomainProblem)).toEqual([null, null, null, null]);
    expect([mailDomainProblem('192.0.2.1'), mailDomainProblem('[2001:db8::1]')]).toEqual([
      'An IP address is no domain: give a name, such as example.tn',
      'An IP address is no domain: give a name, such as example.tn',
    ]);
    expect(mailDomainProblem('example.123')).toBe('A domain ends with a name, not a number');
    expect(mailDomainProblem('-shop.example.tn')).toBe('"-shop" is not a label: 1 to 63 letters, digits and hyphens, not starting or ending with a hyphen');
    expect([mailDomainProblem('shop_1.example.tn'), mailDomainProblem('shop..example.tn'), mailDomainProblem(`${'a'.repeat(64)}.tn`)].map((problem) => problem?.split(' is ')[0])).toEqual([
      '"shop_1"',
      '""',
      `"${'a'.repeat(64)}"`,
    ]);
    expect(mailDomainProblem(`${'a.'.repeat(127)}tn`)).toBe('A domain has 1 to 253 characters');
  });

  it('takes an address of a local part as mailbox providers take one, at such a domain', () => {
    expect(['orders@example.tn', "o'brien+news@shop.example.tn", 'a.b.c@example.tn'].map(addressProblem)).toEqual([null, null, null]);
    expect(addressProblem('orders@')).toBe('An address is a local part, @ and a domain, such as orders@example.tn');
    for (const local of ['.orders', 'a..b', '"quoted"', 'a'.repeat(65)]) expect(addressProblem(`${local}@example.tn`)).toMatch(new RegExp(`^"${local}" is not an address's local part`));
    expect(addressProblem('orders@localhost')).toBe("The address's domain: A domain has two labels at least, such as example.tn");
    expect(addressProblem(`a@${'b'.repeat(320)}.tn`)).toBe('An address has 320 characters at most');
    expect(domainOf('orders@shop.example.tn')).toBe('shop.example.tn');
  });
});
