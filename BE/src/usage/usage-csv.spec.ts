import { csvField, usageCsv, wantsCsv } from './usage-csv';
import { MonthlyUsageView } from './usage.dto';

describe('usage as CSV (P-22, P-30)', () => {
  const amounts = { requests: 3, billedMs: 1_016, gbSeconds: '0.127', throttled: 1, platformErrors: 0, lost: 2 };
  const view: MonthlyUsageView = {
    month: '2026-10',
    functions: [
      { functionId: '3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f', functionName: 'resize, "fast"', deleted: false, ...amounts, cost: '0.008' },
      { functionId: 'a7d4e2c1-6b3f-4d8e-9a1b-2c3d4e5f6a7b', functionName: '=HYPERLINK("http://x")', deleted: true, ...amounts, gbSeconds: '0.0008818359375', cost: '0.000' },
    ],
    databases: [{ databaseId: '7c1d9e2a-4b3f-4e8d-9a6c-5b4a3c2d1e0f', name: 'orders', deleted: false, hours: 312, gbMonths: '0.003182', sizeBytes: 7_634_423, cost: '0.001' }],
    buckets: [
      {
        bucketId: '0b6f3a1c-2d4e-4f5a-8b9c-1d2e3f4a5b6c',
        name: 'photos',
        deleted: true,
        hours: 312,
        gbMonths: '0.215231',
        sizeBytes: 161_480_253,
        objects: 1_204,
        tier1Requests: 2_310,
        tier2Requests: 48_920,
        bytesDownloaded: 2_831_155_200,
        bytesUploaded: 734_003_200,
        cost: '0.108',
      },
    ],
    totals: amounts,
    estimate: null,
  };
  const HEADER = 'kind,id,name,deleted,requests,billed_ms,gb_seconds,gb_months,tier1_requests,tier2_requests,bytes_downloaded,bytes_uploaded,throttled,platform_errors,lost,cost\r\n';

  it("has a header, a line per function, then per database, then per bucket, each with its estimated cost and the other kinds' columns empty, ends lines with CRLF, and leaves the total out", () => {
    expect(usageCsv(view)).toBe(
      HEADER +
        'function,3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f,"resize, ""fast""",false,3,1016,0.127,,,,,,1,0,2,0.008\r\n' +
        `function,a7d4e2c1-6b3f-4d8e-9a1b-2c3d4e5f6a7b,"'=HYPERLINK(""http://x"")",true,3,1016,0.0008818359375,,,,,,1,0,2,0.000\r\n` +
        'database,7c1d9e2a-4b3f-4e8d-9a6c-5b4a3c2d1e0f,orders,false,,,,0.003182,,,,,,,,0.001\r\n' +
        'bucket,0b6f3a1c-2d4e-4f5a-8b9c-1d2e3f4a5b6c,photos,true,,,,0.215231,2310,48920,2831155200,734003200,,,,0.108\r\n',
    );
  });

  it('leaves the cost empty without a price book', () => {
    expect(usageCsv({ ...view, functions: [{ ...view.functions[0], cost: null }] }).split('\r\n')[1]).toBe(
      'function,3f9c2a1e-8b7d-4c6a-9e5f-1a2b3c4d5e6f,"resize, ""fast""",false,3,1016,0.127,,,,,,1,0,2,',
    );
  });

  it('is just its header for a month without calls, databases or buckets', () => {
    expect(usageCsv({ ...view, functions: [], databases: [], buckets: [] })).toBe(HEADER);
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
