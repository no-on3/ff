/** An invoice's or credit note's number: its series, its fiscal year and its sequence, FAC-2026-000001 (P-36). */
export const invoiceNumber = (series: string, fiscalYear: number, sequence: number): string => `${series}-${fiscalYear}-${String(sequence).padStart(6, '0')}`;

/** Where an issued document's PDF is kept: by its number, so a retry after a failure writes the same key. */
export const pdfKey = (number: string): string => `invoices/${number}.pdf`;
