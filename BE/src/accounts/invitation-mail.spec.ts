/**
 * L1: the e-mail an invitation sends, in English and in French: who invites,
 * to which account and as what, and the day to join by.
 */
import { invitationMail } from './invitation-mail';

const FACTS = {
  inviter: { email: 'amira@ff.tn', name: 'Amira Ben Salah' },
  account: { name: 'Tunis Labs' },
  role: 'developer' as const,
  expiresAt: new Date('2026-10-26T09:00:00Z'),
  consoleUrl: 'https://console.ff.tn',
};

describe("an invitation's e-mail", () => {
  it('in English: who invites, to which account, as what, and the day to join by', () => {
    expect(invitationMail(FACTS, 'en')).toEqual({
      subject: 'amira@ff.tn invited you to the FF account "Tunis Labs"',
      text: [
        'Amira Ben Salah invited you to join the FF account "Tunis Labs" as developer.',
        '',
        'Log in to the FF console with this address before 2026-10-26 to join: https://console.ff.tn',
        'Without a login yet, sign up there with this address.',
        '',
        "If you didn't expect this e-mail, ignore it: nothing happens until you log in.",
      ].join('\n'),
    });
  });

  it('in French, each role named in French', () => {
    expect(invitationMail(FACTS, 'fr')).toEqual({
      subject: 'amira@ff.tn vous invite sur le compte FF « Tunis Labs »',
      text: [
        'Amira Ben Salah vous invite à rejoindre le compte FF « Tunis Labs » en tant que développeur.',
        '',
        'Connectez-vous à la console FF avec cette adresse avant le 26 octobre 2026 pour le rejoindre : https://console.ff.tn',
        "Si vous n'avez pas encore d'identifiant, inscrivez-vous-y avec cette adresse.",
        '',
        "Si vous n'attendiez pas cet e-mail, ignorez-le : rien ne se passe tant que vous ne vous connectez pas.",
      ].join('\n'),
    });
    expect((['owner', 'viewer'] as const).map((role) => invitationMail({ ...FACTS, role }, 'fr').text.split('\n')[0])).toEqual([
      'Amira Ben Salah vous invite à rejoindre le compte FF « Tunis Labs » en tant que propriétaire.',
      'Amira Ben Salah vous invite à rejoindre le compte FF « Tunis Labs » en tant que lecteur.',
    ]);
  });

  it("names the inviter by their address when they gave no name", () => {
    expect(invitationMail({ ...FACTS, inviter: { email: 'amira@ff.tn', name: null } }, 'fr').text).toMatch(/^amira@ff\.tn vous invite/);
  });
});
