import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * An account's limits (D5). One plan, "beta", exists from the start, with the
 * limits of P-15's migration. PlansService reads them, checked (plan-limits.ts).
 */
@Entity('plans')
export class Plan {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text' })
  name: string;

  /** A PlanLimits object; parsePlanLimits checks it before use. */
  @Column({ type: 'jsonb' })
  limits: Record<string, unknown>;
}
