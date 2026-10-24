import { Baseline1792196726061 } from './1792196726061-Baseline';
import { ScalingModel1792202064250 } from './1792202064250-ScalingModel';
import { AccountsAndUsers1792212624716 } from './1792212624716-AccountsAndUsers';
import { ApiKeys1792214380231 } from './1792214380231-ApiKeys';
import { PlanLimits1792218389612 } from './1792218389612-PlanLimits';
import { Invitations1792220311930 } from './1792220311930-Invitations';
import { AuditLog1792221758532 } from './1792221758532-AuditLog';
import { UsageRecords1792222975039 } from './1792222975039-UsageRecords';
import { CapacitySamples1792226697538 } from './1792226697538-CapacitySamples';
import { PlatformSettings1792229526506 } from './1792229526506-PlatformSettings';
import { PriceBooks1792235773406 } from './1792235773406-PriceBooks';
import { Ledger1792239798928 } from './1792239798928-Ledger';
import { Rating1792241835410 } from './1792241835410-Rating';
import { CreditControls1792244277487 } from './1792244277487-CreditControls';
import { BankTransfers1792246542708 } from './1792246542708-BankTransfers';
import { Invoices1792251640141 } from './1792251640141-Invoices';
import { CancelledProFormas1792259449848 } from './1792259449848-CancelledProFormas';
import { InvocationHistory1792282243364 } from './1792282243364-InvocationHistory';
import { ClosedAccountDeletion1792325241958 } from './1792325241958-ClosedAccountDeletion';
import { RateLimitedInvocations1792419122035 } from './1792419122035-RateLimitedInvocations';
import { Notifications1792424270622 } from './1792424270622-Notifications';
import { Alarms1792462186640 } from './1792462186640-Alarms';
import { UniqueFunctionNames1792545248288 } from './1792545248288-UniqueFunctionNames';
import { FunctionEnvironments1792555028887 } from './1792555028887-FunctionEnvironments';
import { EventFormat1792558201826 } from './1792558201826-EventFormat';
import { FunctionUrls1792559781729 } from './1792559781729-FunctionUrls';
import { CustomDomains1792564226078 } from './1792564226078-CustomDomains';
import { Schedules1792568579855 } from './1792568579855-Schedules';
import { FunctionPackages1792581123640 } from './1792581123640-FunctionPackages';
import { Packages1792584171843 } from './1792584171843-Packages';
import { CodeImages1792586195192 } from './1792586195192-CodeImages';
import { InlineCodePackages1792596918071 } from './1792596918071-InlineCodePackages';
import { Databases1792724178089 } from './1792724178089-Databases';
import { DatabaseBilling1792727200566 } from './1792727200566-DatabaseBilling';
import { DatabaseOperations1792731046155 } from './1792731046155-DatabaseOperations';
import { Buckets1792737696352 } from './1792737696352-Buckets';
import { BucketLimits1792739264070 } from './1792739264070-BucketLimits';
import { FunctionKeys1792743758847 } from './1792743758847-FunctionKeys';
import { BucketSamples1792746521862 } from './1792746521862-BucketSamples';
import { BucketAlarms1792748816752 } from './1792748816752-BucketAlarms';
import { QueueLimits1792770408267 } from './1792770408267-QueueLimits';
import { AsyncInvoke1792771678484 } from './1792771678484-AsyncInvoke';
import { EventInvokeConfigs1792777408931 } from './1792777408931-EventInvokeConfigs';
import { CustomerQueues1792783890375 } from './1792783890375-CustomerQueues';
import { AsyncNotify1792790149607 } from './1792790149607-AsyncNotify';
import { KeyQueues1792792790340 } from './1792792790340-KeyQueues';
import { EventSourceMappings1792803225587 } from './1792803225587-EventSourceMappings';
import { BucketNotifications1792810703773 } from './1792810703773-BucketNotifications';

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
  Invitations1792220311930,
  AuditLog1792221758532,
  UsageRecords1792222975039,
  CapacitySamples1792226697538,
  PlatformSettings1792229526506,
  PriceBooks1792235773406,
  Ledger1792239798928,
  Rating1792241835410,
  CreditControls1792244277487,
  BankTransfers1792246542708,
  Invoices1792251640141,
  CancelledProFormas1792259449848,
  InvocationHistory1792282243364,
  ClosedAccountDeletion1792325241958,
  RateLimitedInvocations1792419122035,
  Notifications1792424270622,
  Alarms1792462186640,
  UniqueFunctionNames1792545248288,
  FunctionEnvironments1792555028887,
  EventFormat1792558201826,
  FunctionUrls1792559781729,
  CustomDomains1792564226078,
  Schedules1792568579855,
  FunctionPackages1792581123640,
  Packages1792584171843,
  CodeImages1792586195192,
  InlineCodePackages1792596918071,
  Databases1792724178089,
  DatabaseBilling1792727200566,
  DatabaseOperations1792731046155,
  Buckets1792737696352,
  BucketLimits1792739264070,
  FunctionKeys1792743758847,
  BucketSamples1792746521862,
  BucketAlarms1792748816752,
  QueueLimits1792770408267,
  AsyncInvoke1792771678484,
  EventInvokeConfigs1792777408931,
  CustomerQueues1792783890375,
  AsyncNotify1792790149607,
  KeyQueues1792792790340,
  EventSourceMappings1792803225587,
  BucketNotifications1792810703773,
];
