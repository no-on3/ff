import { Column, Entity, PrimaryColumn } from 'typeorm';

/** An account's limits (D5). One plan, "beta", exists from the start; P-15 fills its limits. */
@Entity('plans')
export class Plan {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'jsonb' })
  limits: Record<string, unknown>;
}
