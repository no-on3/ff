import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { describeError } from '../common/describe-error';
import { withJobLock } from '../database/job-lock';
import { ORCHESTRATOR, Orchestrator, WorkloadInstances } from '../orchestrator/orchestrator.types';
import { readyTimeoutMs } from '../orchestrator/ready-timeout';
import { FunctionKeys, KeysToRenew } from '../storage/function-keys.service';
import { FunctionsService, differsByKeyAlone } from './functions.service';

const RENEWAL_LOCK = 'ff_function_key_renewal';

/** What a turn of the renewal did. */
export interface KeyRenewalReport {
  /** Deployments rolled onto their function's current key; at zero, their template alone. */
  rolled: number;
  /** Keys replaced, revoked once no Deployment held them. */
  revoked: number;
  /** Functions left for a later turn: a change under way holds their pods, or one that failed, or they aren't ACTIVE. */
  waiting: number;
  /** Functions whose renewal failed, each logged: the next turn tries again. */
  failures: number;
}

/**
 * The renewal of functions' keys (ADR 0014, 5), each minute
 * (FF_KEY_RENEWAL_INTERVAL_SECONDS), in one backend at a time. A function whose key is past half its life and that has pods running
 * gets a new key: each of its Deployments, $LATEST's and its versions', is
 * rolled onto it in turn, its pods replaced one at a time, a new one ready
 * before an old one goes, and the next Deployment once the last is done; one at
 * zero has its template written, which its next start reads. The keys it
 * replaced work on until a turn finds every Deployment of the function on the
 * current key and no pod on another, a pod told to stop answering the call it
 * runs first, and revokes them: no pod holds a revoked key. An idle
 * function's key is renewed as it starts from zero, which its call does; a
 * Deployment an update is rolling out, or one whose update failed, is left to
 * it, its own rollout giving the pods the current key. A lasting key, made
 * before keys ended, never ends on its own: it is renewed at the first turn,
 * the function's templates written at zero too, and revoked at the next, or at
 * once for a function with no Deployment, whose next rollout makes it a key.
 */
@Injectable()
export class FunctionKeyRenewal implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FunctionKeyRenewal.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dataSource: DataSource,
    private readonly keys: FunctionKeys,
    private readonly functions: FunctionsService,
    @Inject(ORCHESTRATOR) private readonly orchestrator: Orchestrator,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    const turn = () => void this.renewDue().catch((error: unknown) => this.logger.error(`The renewal of functions' keys failed: ${describeError(error)}`));
    // A minute by default, where a key due has six hours left.
    this.timer = setInterval(turn, this.config.getOrThrow<number>('keyRenewal.intervalSeconds') * 1000);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  /**
   * One turn: every function whose key is due, or that has keys replaced, its
   * Deployments read from one list of the cluster's. A turn that comes while
   * another runs, here or in another backend, does nothing.
   */
  async renewDue(now = new Date()): Promise<KeyRenewalReport> {
    const report: KeyRenewalReport = { rolled: 0, revoked: 0, waiting: 0, failures: 0 };
    await withJobLock(this.dataSource, RENEWAL_LOCK, async () => {
      const pending = await this.keys.toRenew(now);
      if (pending.length === 0) return;
      const deployments = byFunction(await this.orchestrator.workloads());
      for (const keys of pending) {
        try {
          await this.renew(keys, deployments.get(keys.functionId) ?? [], report, now);
        } catch (error) {
          report.failures++;
          this.logger.error(`Could not renew the key of function ${keys.functionId}: ${describeError(error)}`);
        }
      }
    });
    if (report.rolled || report.revoked || report.failures) {
      this.logger.log(
        `Functions' keys renewed: ${report.rolled} Deployment(s) rolled onto a new key, ${report.revoked} old key(s) revoked, ` +
          `${report.waiting} function(s) left for a change under way, ${report.failures} failure(s)`,
      );
    }
    return report;
  }

  private async renew(keys: KeysToRenew, deployments: WorkloadInstances[], report: KeyRenewalReport, now: Date): Promise<void> {
    // Idle: no pod holds its key, which its start from zero renews, or its end stops; a lasting key has none.
    if (!keys.replaced && !keys.lasting && !deployments.some((deployment) => deployment.desired > 0)) return;
    let rolled = 0;
    for (const deployment of deployments) {
      // The first workload made renews a key due; the others find the new one.
      const workload = await this.functions.runningWorkload(keys.functionId, deployment.version);
      if (!workload) {
        report.waiting++;
        return;
      }
      if (deployment.revision === workload.environment?.revision) continue;
      if (!differsByKeyAlone(deployment, workload)) {
        report.waiting++;
        return;
      }
      await this.orchestrator.renewEnvironment(workload);
      // The pods it replaces answer as the new ones do, their old key working until it is revoked, below.
      await this.orchestrator.waitUntilReady(workload, readyTimeoutMs(this.config), { replacedMayAnswer: true });
      rolled++;
    }
    report.rolled += rolled;
    // Revoked by a turn that finds every Deployment on the current key, for those rolled now a later one, and no pod
    // on another: a pod told to stop answers the call it runs first, with the key it has.
    const revoking = keys.replaced || (keys.lasting && deployments.length === 0);
    if (rolled > 0 || !revoking) return;
    if (await this.podOnAnotherKey(keys, deployments)) {
      report.waiting++;
      return;
    }
    if (keys.replaced) report.revoked += await this.keys.revokeReplaced(keys.functionId, now);
    if (keys.lasting && deployments.length === 0) report.revoked += await this.keys.revokeLasting(keys.functionId, now);
  }

  /** Whether a pod of the function runs with another environment than its Deployments' templates: an old pod, with an old key. */
  private async podOnAnotherKey(keys: KeysToRenew, deployments: WorkloadInstances[]): Promise<boolean> {
    const current = new Set(deployments.map((deployment) => deployment.revision ?? ''));
    const pods = await this.orchestrator.podRevisions({ id: keys.functionId, accountId: keys.accountId });
    return pods.some((revision) => !current.has(revision));
  }
}

/** The cluster's Deployments of functions, by function. */
function byFunction(deployments: WorkloadInstances[]): Map<string, WorkloadInstances[]> {
  const grouped = new Map<string, WorkloadInstances[]>();
  for (const deployment of deployments) grouped.set(deployment.functionId, [...(grouped.get(deployment.functionId) ?? []), deployment]);
  return grouped;
}
