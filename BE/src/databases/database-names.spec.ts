import { DATABASE_NAME, SERVER_NAME, databaseNameProblem, newPassword, newServerName } from './database-names';
import { scramVerifier } from './scram';

describe("customers' databases' names and passwords", () => {
  it.each(['orders', 'a', 'shop-2026', `a${'b'.repeat(62)}`])('take %s as a database name, as RDS would', (name) => {
    expect(databaseNameProblem(name)).toBeUndefined();
  });

  it.each(['', 'Orders', '2shop', 'my_db', 'two--hyphens', 'trailing-', 'dots.no', `a${'b'.repeat(63)}`])('refuse %p, saying what a name is', (name) => {
    expect(databaseNameProblem(name)).toContain('is not a database name: 1 to 63 lower-case letters, digits and hyphens');
  });

  it('keep the regular expression to what the rule says, no hyphen last aside', () => {
    expect(DATABASE_NAME.test('ok-')).toBe(true);
    expect(databaseNameProblem('ok-')).toBeDefined();
  });

  it("name a database and its user on the server ff_ and 24 random hexadecimal characters, a new one each time", () => {
    const names = new Set(Array.from({ length: 50 }, newServerName));

    expect(names.size).toBe(50);
    for (const name of names) expect(name).toMatch(SERVER_NAME);
  });

  it('make passwords of 32 random bytes that need no escaping in a connection string', () => {
    const password = newPassword();

    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newPassword()).not.toBe(password);
  });

  describe('the SCRAM-SHA-256 verifier the server is sent', () => {
    // RFC 7677's salt and password, the keys computed with Python's hashlib and hmac, an implementation of its own.
    const salt = Buffer.from('W22ZaJ0SNY7soEsUEjb6gQ==', 'base64');

    it("is PostgreSQL's stored form: iterations and salt, then the stored key and the server key", () => {
      expect(scramVerifier('pencil', salt)).toBe(
        'SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=',
      );
    });

    it('takes a new salt each time, so that one password never gives the same verifier twice', () => {
      expect(scramVerifier('pencil')).not.toBe(scramVerifier('pencil'));
      expect(scramVerifier('pencil')).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    });

    it('refuses a password SASLprep would change, which FF never makes', () => {
      expect(() => scramVerifier('pâssword')).toThrow('printable ASCII');
      expect(() => scramVerifier('with space')).toThrow('printable ASCII');
    });
  });
});
