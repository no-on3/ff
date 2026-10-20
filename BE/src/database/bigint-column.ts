import { ValueTransformer } from 'typeorm';

/** PostgreSQL's bigint, which the driver reads as a string, as a JavaScript bigint: never a number (P-31). */
export const bigintColumn: ValueTransformer = {
  to: (value: bigint | null | undefined) => (value === null || value === undefined ? value : value.toString()),
  from: (value: string | null) => (value === null ? null : BigInt(value)),
};
