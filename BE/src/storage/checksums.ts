import { Crc32c, Crc64Nvme } from '@aws-sdk/checksums/crc';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';

/** The checksums S3 checks an upload against, by their names in its headers (x-amz-checksum-<name>). */
export const CHECKSUM_ALGORITHMS = ['crc32', 'crc32c', 'crc64nvme', 'sha1', 'sha256'] as const;
export type ChecksumAlgorithm = (typeof CHECKSUM_ALGORITHMS)[number];

export const isChecksumAlgorithm = (name: string): name is ChecksumAlgorithm => (CHECKSUM_ALGORITHMS as readonly string[]).includes(name);

/** A checksum computed as a body streams past: its value at the end in base64, as S3's headers carry it. */
export interface RunningChecksum {
  update(chunk: Buffer): void;
  digest(): Promise<string>;
}

/** A 32-bit value as its 4 bytes, most significant first, in base64. */
const uint32 = (value: number): string => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value >>> 0);
  return bytes.toString('base64');
};

/** A running checksum of the algorithm: CRC-32 and the SHAs from Node.js, CRC-32C and CRC-64/NVME from AWS's own package. */
export function runningChecksum(algorithm: ChecksumAlgorithm): RunningChecksum {
  switch (algorithm) {
    case 'crc32': {
      let value = 0;
      return {
        update: (chunk) => {
          value = crc32(chunk, value);
        },
        digest: () => Promise.resolve(uint32(value)),
      };
    }
    case 'crc32c':
    case 'crc64nvme': {
      const checksum = algorithm === 'crc32c' ? new Crc32c() : new Crc64Nvme();
      return {
        update: (chunk) => checksum.update(chunk),
        digest: async () => Buffer.from(await checksum.digest()).toString('base64'),
      };
    }
    case 'sha1':
    case 'sha256': {
      const hash = createHash(algorithm);
      return {
        update: (chunk) => {
          hash.update(chunk);
        },
        digest: () => Promise.resolve(hash.digest('base64')),
      };
    }
  }
}
