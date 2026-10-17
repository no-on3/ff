import { csvField, usageCsv, wantsCsv } from './usage-csv';
import { MonthlyUsageView } from './usage.dto';

describe('usage as CSV (P-22)', () => {
  const amounts = { requests: 3, billedMs: 1_016, gbSeconds: '0.127', throttled: 1, platformErrors: 0, lost: 2 };
  const view: MonthlyUsageView = {
    month: '2026-10',
    functions: [
      { functionId: '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f', functionName: 'resize, "fast"', deleted: false, ...amounts },
      { functionId: 'a7d4e2c1-6b3f-4d8e-9a1b-2c3d4e5f6a7b', functionName: '=HYPERLINK("http://x")', deleted: true, ...amounts, gbSeconds: '0.0008818359375' },
    ],
    totals: amounts,
  };

  it('has a header and a line per function, ends lines with CRLF, and leaves the total out', () => {
    expect(usageCsv(view)).toBe(
      'function_id,function_name,deleted,requests,billed_ms,gb_seconds,throttled,platform_errors,lost\r\n' +
        '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f,"resize, ""fast""",false,3,1016,0.127,1,0,2\r\n' +
        `a7d4e2c1-6b3f-4d8e-9a1b-2c3d4e5f6a7b,"'=HYPERLINK(""http://x"")",true,3,1016,0.0008818359375,1,0,2\r\n`,
    );
  });

  it('is just its header for a month without calls', () => {
    expect(usageCsv({ ...view, functions: [] })).toBe('function_id,function_name,deleted,requests,billed_ms,gb_seconds,throttled,platform_errors,lost\r\n');
  });

  it.each([
    ['plain', 'hello', 'hello'],
    ['a comma', 'a,b', '"a,b"'],
    ['a quote', 'say "hi"', '"say ""hi"""'],
    ['a line break', 'two\nlines', '"two\nlines"'],
  ])('quotes a field only when it must (RFC 4180): %s', (_case, value, field) => {
    expect(csvField(value)).toBe(field);
  });

  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])(
    'keeps a spreadsheet from running free text as a formula: %j',
    (name) => {
      expect(csvField(name, true).replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );

  it('leaves numbers, booleans and other text as they are', () => {
    expect([csvField(-1), csvField(false), csvField('-1'), csvField('hello', true)]).toEqual(['-1', 'false', '-1', 'hello']);
  });

  it.each([
    ['text/csv', true],
    ['text/csv; charset=utf-8', true],
    ['application/json;q=0.5, TEXT/CSV', true],
    ['application/json', false],
    ['text/html,application/xhtml+xml,*/*;q=0.8', false],
    [undefined, false],
  ])('reads Accept: %s as CSV: %s', (accept, csv) => {
    expect(wantsCsv(accept)).toBe(csv);
  });
});
