import { inflateSync } from 'node:zlib';

const WINDOWS_1252 = new TextDecoder('windows-1252');

/** A text drawn on a page: where, and what. */
interface Drawn {
  x: number;
  y: number;
  text: string;
}

/**
 * The text of a PDF that FF wrote with pdfkit's standard fonts, as rows a
 * person reads (P-36): page by page, top to bottom, each row's texts left to
 * right, joined with " | ". For tests and checks: pdfkit writes each line of
 * text as a block (BT … ET) placed by its matrix (Tm), in hex strings of
 * Windows-1252; a compressed stream is inflated first.
 */
export function pdfRows(pdf: Buffer): string[][] {
  const source = pdf.toString('latin1');
  // Every object's dictionary, and its stream, inflated when compressed.
  const objects = new Map<number, { dictionary: string; stream: string | null }>();
  const header = /(\d+) 0 obj\s*<<([\s\S]*?)>>\s*(stream\r?\n)?/g;
  for (let match = header.exec(source); match; match = header.exec(source)) {
    let stream: string | null = null;
    if (match[3]) {
      const start = match.index + match[0].length;
      let bytes = pdf.subarray(start, source.indexOf('endstream', start));
      if (/\/FlateDecode/.test(match[2])) bytes = inflateSync(bytes);
      stream = bytes.toString('latin1');
    }
    objects.set(Number(match[1]), { dictionary: match[2], stream });
  }
  const refs = (text: string) => [...text.matchAll(/(\d+) 0 R/g)].map((ref) => Number(ref[1]));
  // The pages in order, from the page tree's kids; each page's content streams, footers included.
  const tree = [...objects.values()].find((object) => /\/Type \/Pages\b/.test(object.dictionary));
  const kids = refs(/\/Kids \[([^\]]*)\]/.exec(tree?.dictionary ?? '')?.[1] ?? '');
  return kids.map((kid) => {
    const page = objects.get(kid)?.dictionary ?? '';
    const contents = /\/Contents (\[[^\]]*\]|\d+ 0 R)/.exec(page)?.[1] ?? '';
    const drawn: Drawn[] = [];
    for (const ref of refs(contents)) {
      for (const block of objects.get(ref)?.stream?.match(/BT[\s\S]*?ET/g) ?? []) {
        const matrix = /([-\d.]+) ([-\d.]+) Tm/.exec(block);
        const hex = [...block.matchAll(/<([0-9a-fA-F]*)>/g)].map((part) => part[1]).join('');
        const text = WINDOWS_1252.decode(Buffer.from(hex, 'hex'));
        if (matrix && text.trim()) drawn.push({ x: Number(matrix[1]), y: Number(matrix[2]), text });
      }
    }
    const rows = new Map<number, Drawn[]>();
    for (const item of drawn) {
      const key = [...rows.keys()].find((y) => Math.abs(y - item.y) < 2) ?? item.y;
      rows.set(key, [...(rows.get(key) ?? []), item]);
    }
    return [...rows.entries()].sort(([a], [b]) => b - a).map(([, items]) => items.sort((a, b) => a.x - b.x).map((item) => item.text.trim()).join(' | '));
  });
}
