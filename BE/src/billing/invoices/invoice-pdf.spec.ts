/**
 * L1: the invoice, credit note and statement PDFs (client-readiness plan,
 * P-36), read back as rows of text, page by page: what a buyer and the tax
 * office read on them.
 */
import { InvoiceDocument, pdfText, renderInvoicePdf, renderStatementPdf } from './invoice-pdf';
import { pdfRows } from './pdf-text';
import { Statement } from './statement';

/** The rows with every no-break space as a plain one, as they read. */
const read = async (pdf: Promise<Buffer>) => pdfRows(await pdf).map((rows) => rows.map((row) => row.replace(/\u00a0/g, ' ')));

const SELLER = { name: 'FF SARL', taxId: '1234567/A/M/000', address: '1 rue du Lac, 1053 Tunis' };
const BUYER = { name: 'Tunis Labs', taxId: '7654321/B/A/M/000', accountId: '000000000001' };
const STATEMENT: Statement = {
  month: '2026-10',
  currency: 'TND',
  exponent: 3,
  functions: [
    { functionId: 'f-2', name: 'hello', requests: 2_000_000n, gbSeconds: '1000000', amountMinor: 51_337n },
    { functionId: 'f-1', name: 'resize-images', requests: 10n, gbSeconds: '0.00125', amountMinor: 0n },
  ],
  resources: [],
  usageMinor: 51_337n,
  freeTierMinor: -20_655n,
  volumeTiersMinor: 0n,
  monthlyFeeMinor: 0n,
  totalMinor: 30_682n,
  debitedMinor: 30_682n,
  shadowMinor: 0n,
  ratedUntil: new Date('2026-11-01T00:00:00Z'),
  complete: true,
};
const INVOICE: InvoiceDocument = {
  kind: 'invoice',
  number: 'FAC-2026-000001',
  issuedOn: '2026-11-02',
  month: '2026-10',
  corrects: null,
  reason: null,
  seller: SELLER,
  buyer: BUYER,
  currency: 'TND',
  exponent: 3,
  lines: [
    { description: 'Crédit prépayé FF : virement reçu le 5 octobre 2026, pro forma FF-AAAA-BBBB', amountMinor: 50_000n, vatPercent: 19, vatMinor: 9_500n },
    { description: 'Crédit prépayé FF : virement reçu le 20 octobre 2026, pro forma FF-CCCC-DDDD', amountMinor: 1_000_000n, vatPercent: 19, vatMinor: 190_000n },
  ],
  subtotalMinor: 1_050_000n,
  vatMinor: 199_500n,
  stampDutyMinor: 1_000n,
  totalMinor: 1_250_500n,
  paid: { receivedMinor: 1_231_765n, withheldMinor: 17_735n },
  statement: STATEMENT,
};

describe('the invoice PDF (L1, P-36)', () => {
  it("names the document, the seller, the buyer and its account, then a line per payment with its VAT, the totals and the stamp duty", async () => {
    const [first, statement, ...rest] = await read(renderInvoicePdf(INVOICE, new Date('2026-11-02T09:00:00Z')));

    expect(rest).toEqual([]); // the invoice, then its statement
    expect(first).toEqual([
      'FACTURE',
      'N° FAC-2026-000001',
      'Date : 2 novembre 2026',
      'Période : octobre 2026',
      'Client',
      'FF SARL',
      'Tunis Labs',
      '1 rue du Lac, 1053 Tunis',
      'Matricule fiscal : 7654321/B/A/M/000',
      'Matricule fiscal : 1234567/A/M/000',
      'Compte FF : 000000000001',
      'Désignation | Montant HT | TVA | Montant TVA',
      'Crédit prépayé FF : virement reçu le 5 octobre 2026, | 50,000 TND | 19 % | 9,500 TND',
      'pro forma FF-AAAA-BBBB',
      'Crédit prépayé FF : virement reçu le 20 octobre 2026, | 1 000,000 TND | 19 % | 190,000 TND',
      'pro forma FF-CCCC-DDDD',
      'Total HT | 1 050,000 TND',
      'TVA 19 % | 199,500 TND',
      'Droit de timbre | 1,000 TND',
      'Total TTC | 1 250,500 TND',
      'Crédit prépayé réglé par virement bancaire : 1 249,500 TND, dont 17,735 TND retenus à la source par le client.',
      'Le droit de timbre est prélevé sur le crédit prépayé.',
      "La consommation est débitée du crédit prépayé, facturé à l'achat : elle n'est pas facturée à nouveau. Son relevé du mois est joint.",
      'FF SARL · 1 rue du Lac, 1053 Tunis · Matricule fiscal : 1234567/A/M/000 · FAC-2026-000001 · Page 1/2',
    ]);
    expect(statement[0]).toBe('Relevé de consommation');
    expect(statement.at(-1)).toBe('FF SARL · 1 rue du Lac, 1053 Tunis · Matricule fiscal : 1234567/A/M/000 · FAC-2026-000001 · Page 2/2');
  });

  it("attaches the month's statement: each function, the free tier, the total, and what was debited", async () => {
    const [, statement] = await read(renderInvoicePdf(INVOICE));

    expect(statement).toEqual([
      'Relevé de consommation',
      'octobre 2026 (mois en temps universel)',
      'Tunis Labs · Compte FF : 000000000001',
      'Fonction | Requêtes | GB-secondes | Montant HT',
      'hello | 2 000 000 | 1 000 000 | 51,337 TND',
      'resize-images | 10 | 0,00125 | 0,000 TND',
      'Consommation | 51,337 TND',
      'Franchise gratuite | -20,655 TND',
      'Total HT | 30,682 TND',
      'Débité du crédit prépayé : 30,682 TND.',
      "Montants hors taxe : la TVA a été facturée à l'achat du crédit prépayé, qui règle cette consommation.",
      'FF SARL · 1 rue du Lac, 1053 Tunis · Matricule fiscal : 1234567/A/M/000 · FAC-2026-000001 · Page 2/2',
    ]);
  });

  it('lists the databases after the functions, each with its GB-months and amount', async () => {
    const resources = [
      { resourceId: 'd-1', kind: 'database' as const, name: 'audit', gbMonths: '0.268817', tier1Requests: 0n, tier2Requests: 0n, amountMinor: 93n },
      { resourceId: 'd-2', kind: 'database' as const, name: 'orders', gbMonths: '1234.5', tier1Requests: 0n, tier2Requests: 0n, amountMinor: 427_038n },
    ];

    const [page] = await read(renderStatementPdf({ ...STATEMENT, resources }, SELLER, BUYER));
    const [alone] = await read(renderStatementPdf({ ...STATEMENT, functions: [], resources }, SELLER, BUYER));

    const rows = page.slice(page.indexOf('resize-images | 10 | 0,00125 | 0,000 TND') + 1);
    expect(rows.slice(0, 4)).toEqual(['Base de données | Go-mois | Montant HT', 'audit | 0,268817 | 0,093 TND', 'orders | 1 234,5 | 427,038 TND', 'Consommation | 51,337 TND']);
    // Without a function, only the databases' table: no line saying there was nothing.
    expect(alone).toEqual(expect.arrayContaining(['Base de données | Go-mois | Montant HT']));
    expect(alone.join('\n')).not.toMatch(/Fonction|Aucune consommation/);
  });

  it('writes a credit note as such: the invoice it corrects, its lines and total, its reason, and no stamp duty', async () => {
    const pages = await read(
      renderInvoicePdf({
        ...INVOICE,
        kind: 'credit_note',
        number: 'AV-2026-000001',
        month: null,
        corrects: 'FAC-2026-000001',
        reason: 'Remboursement du crédit non consommé',
        lines: [{ description: 'Remboursement partiel', amountMinor: 20_000n, vatPercent: 19, vatMinor: 3_800n }],
        subtotalMinor: 20_000n,
        vatMinor: 3_800n,
        stampDutyMinor: 0n,
        totalMinor: 23_800n,
        paid: null,
        statement: null,
      }),
    );

    expect(pages).toHaveLength(1);
    expect(pages[0]).toEqual(
      expect.arrayContaining([
        "FACTURE D'AVOIR",
        'N° AV-2026-000001',
        'Facture corrigée : FAC-2026-000001',
        'Remboursement partiel | 20,000 TND | 19 % | 3,800 TND',
        "Total TTC de l'avoir | 23,800 TND",
        'Motif : Remboursement du crédit non consommé',
      ]),
    );
    expect(pages[0].join('\n')).not.toMatch(/Droit de timbre|Relevé/);
  });

  it('a statement alone names both parties, and says when the month is rated only so far, or only in the billing trial', async () => {
    const [page] = await read(
      renderStatementPdf({ ...STATEMENT, debitedMinor: 0n, shadowMinor: 30_682n, complete: false, ratedUntil: new Date('2026-10-20T15:00:00Z') }, SELLER, BUYER),
    );

    expect(page).toEqual(
      expect.arrayContaining([
        'Relevé de consommation',
        'Compte FF : 000000000001',
        'Débité du crédit prépayé : 0,000 TND.',
        "Évalué pendant la période d'essai de la facturation, sans être débité : 30,682 TND.",
        "Le mois n'est évalué que jusqu'au 20 octobre 2026 à 15:00 UTC : ce relevé n'est pas définitif.",
        'FF SARL · 1 rue du Lac, 1053 Tunis · Matricule fiscal : 1234567/A/M/000 · Relevé 2026-10 · Compte FF 000000000001 · Page 1/1',
      ]),
    );
  });

  it('continues a long statement on the next pages, with its column headings, and counts the pages', async () => {
    const functions = Array.from({ length: 70 }, (_, index) => ({ functionId: `f-${index}`, name: `function-${String(index).padStart(2, '0')}`, requests: 1n, gbSeconds: '1', amountMinor: 1n }));
    const pages = await read(renderStatementPdf({ ...STATEMENT, functions }, SELLER, BUYER));

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((rows) => rows[0] === 'Fonction | Requêtes | GB-secondes | Montant HT' || rows[0] === 'Relevé de consommation')).toBe(true);
    expect(pages.flat().filter((row) => row.startsWith('function-'))).toHaveLength(70);
    expect(pages.map((rows) => rows.at(-1)?.split(' · ').at(-1))).toEqual(pages.map((_, index) => `Page ${index + 1}/${pages.length}`));
  });

  it('takes only the characters its fonts write: the narrow no-break space as a no-break space, and refuses the rest', () => {
    expect(pdfText(`1${String.fromCharCode(0x202f)}000 € — « été » œuvre`)).toBe(`1${String.fromCharCode(0xa0)}000 € — « été » œuvre`);
    expect(() => pdfText('Tunis → Sfax')).toThrow('has a character the PDF\'s fonts can\'t write');
    expect(() => pdfText('تونس')).toThrow();
  });
});
