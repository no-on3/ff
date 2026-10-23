import { CHECKSUM_ALGORITHMS, ChecksumAlgorithm, runningChecksum } from './checksums';

/** Each algorithm's value for "123456789", the CRC catalogue's check value, and the SHAs' as any tool gives them, in base64. */
const CHECK_VALUES: Record<ChecksumAlgorithm, string> = {
  crc32: Buffer.from('cbf43926', 'hex').toString('base64'),
  crc32c: Buffer.from('e3069283', 'hex').toString('base64'),
  crc64nvme: Buffer.from('ae8b14860a799888', 'hex').toString('base64'),
  sha1: Buffer.from('f7c3bc1d808e04732adf679965ccc34ca7ae3441', 'hex').toString('base64'),
  sha256: Buffer.from('15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225', 'hex').toString('base64'),
};

describe('the checksums S3 checks uploads against', () => {
  it.each(CHECKSUM_ALGORITHMS)("%s gives the algorithm's check value", async (algorithm) => {
    const checksum = runningChecksum(algorithm);
    checksum.update(Buffer.from('123456789'));

    expect(await checksum.digest()).toBe(CHECK_VALUES[algorithm]);
  });

  it.each(CHECKSUM_ALGORITHMS)('%s gives the same value, the body in any number of chunks', async (algorithm) => {
    const body = Buffer.from('123456789');
    const checksum = runningChecksum(algorithm);
    for (const piece of [body.subarray(0, 1), body.subarray(1, 1), body.subarray(1, 7), body.subarray(7)]) checksum.update(piece);

    expect(await checksum.digest()).toBe(CHECK_VALUES[algorithm]);
  });

  it("CRC-32C of AWS's example upload, 66,560 bytes of \"a\", is the trailer AWS's documentation shows", async () => {
    const checksum = runningChecksum('crc32c');
    checksum.update(Buffer.alloc(66_560, 'a'));

    expect(await checksum.digest()).toBe('sOO8/Q==');
  });
});
