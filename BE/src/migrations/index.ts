import { Baseline1792196726061 } from './1792196726061-Baseline';
import { ScalingModel1792202064250 } from './1792202064250-ScalingModel';
import { AccountsAndUsers1792212624716 } from './1792212624716-AccountsAndUsers';
import { ApiKeys1792214380231 } from './1792214380231-ApiKeys';
import { PlanLimits1792218389612 } from './1792218389612-PlanLimits';

/**
 * Every migration, oldest first. `npm run migration:generate -- src/migrations/<Name>`
 * writes a new file; add its class here, or it never runs. `npm run migration:check`
 * fails until it is added, because the schema then lags behind the entities.
 */
export const MIGRATIONS: Array<new () => object> = [
  Baseline1792196726061,
  ScalingModel1792202064250,
  AccountsAndUsers1792212624716,
  ApiKeys1792214380231,
  PlanLimits1792218389612,
];
