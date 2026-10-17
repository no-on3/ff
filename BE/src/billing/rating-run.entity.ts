import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

/**
 * An hour the hourly rating finished (P-32): every account with usage in it
 * charged, once. The next hour to rate is the one after the latest.
 */
@Entity('rating_runs')
export class RatingRun {
  /** The hour's start, UTC. */
  @PrimaryColumn({ type: 'timestamptz' })
  hour: Date;

  /** How many accounts had usage in it, and were charged. */
  @Column({ type: 'int' })
  accounts: number;

  /** Rated in shadow mode (D9): its charges were recorded, not debited. */
  @Column({ type: 'boolean' })
  shadow: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  ratedAt: Date;
}
