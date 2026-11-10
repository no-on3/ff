import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKSUM_ALGORITHMS, ChecksumAlgorithm, runningChecksum } from './checksums';

/** The check values and AWS's examples, the table ff's tests read too. */
const table = JSON.parse(readFileSync(join(__dirname, 'checksum-check-values.json'), 'utf8')) as {
  checkInput: string;
  checkValues: Record<ChecksumAlgorithm, string>;
  examples: Array<{ title: string; algorithm: ChecksumAlgorithm; byte: string; length: number; base64: string }>;
};
/** Each algorithm's value for the check input, in base64, as S3 carries it. */
const CHECK_VALUES = Object.fromEntries(Object.entries(table.checkValues).map(([algorithm, hex]) => [algorithm, Buffer.from(hex, 'hex').toString('base64')])) as Record<
  ChecksumAlgorithm,
  string
>;

describe('the checksums S3 checks uploads against', () => {
  it.each(CHECKSUM_ALGORITHMS)("%s gives the algorithm's check value", async (algorithm) => {
    const checksum = runningChecksum(algorithm);
    checksum.update(Buffer.from(table.checkInput));

    expect(await checksum.digest()).toBe(CHECK_VALUES[algorithm]);
  });

  it.each(CHECKSUM_ALGORITHMS)('%s gives the same value, the body in any number of chunks', async (algorithm) => {
    const body = Buffer.from(table.checkInput);
    const checksum = runningChecksum(algorithm);
    for (const piece of [body.subarray(0, 1), body.subarray(1, 1), body.subarray(1, 7), body.subarray(7)]) checksum.update(piece);

    expect(await checksum.digest()).toBe(CHECK_VALUES[algorithm]);
  });

  it.each(table.examples.map((example) => [example.title, example] as const))('%s', async (_title, example) => {
    const checksum = runningChecksum(example.algorithm);
    checksum.update(Buffer.alloc(example.length, example.byte));

    expect(await checksum.digest()).toBe(example.base64);
  });
});
