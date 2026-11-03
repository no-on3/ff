import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, IsNull, LessThan } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { describeError } from '../common/describe-error';
import { withJobLock } from '../database/job-lock';
import { ORCHESTRATOR, Orchestrator } from '../orchestrator/orchestrator.types';
import { readyTimeoutMs } from '../orchestrator/ready-timeout';
import { PlansService } from '../plans/plans.service';
import { ChangeUnderWay, changeBoundMs, endChange, failedFor, takeFunction } from './change-under-way';
import { Function, FunctionStatus, UpdateStatus } from './entities/function.entity';
import { platformFailure } from './failures';
import { FunctionsService } from './functions.service';

const SWEEP_LOCK = 'ff_stopped_changes';
/** A turn each minute: a change is taken for stopped once past its bound, 4 minutes by default. */
const SWEEP_INTERVAL_MS = 60_000;

/** Why each change a stopped backend left ended Failed, as `GetFunction` gives its reason. */
export const STOPPED_REASONS = {
  create: 'The backend stopped while it created the function: update it to deploy it again, or delete it.',
  undone: 'The backend stopped during this change, which was undone: the version before it is still live. Send the change again.',
  notActive: 'The backend stopped during this change of a function in ERROR, which stays so: update it again, or delete it.',
};

/** What a turn did. */
export interface StoppedChangesReport {
  /** Changes ended Failed, what they left on the cluster undone. */
  ended: number;
  /** Of those, the working functions whose version before the change was rolled out again. */
  rolledOut: number;
  /** Changes that couldn't be ended, each logged: a turn tries again once the change is past its bound once more. */
  failures: number;
}

/** What of a function's record a stopped change's end changes with it. */
type UndoneFields = Partial<Pick<Function, 'status' | 'error'>>;

/** How a stopped change was undone: why it ended, and whether its function's version was rolled out again. */
interface Undone {
  reason: string;
  fields?: UndoneFields;
  rolledOut?: boolean;
}

/**
 * The sweeper of changes a stopped backend left half done (ADR 0014, 6): at
 * the backend's start and each minute, in one backend at a time. A change
 * still under way past its bound, twice the time an instance has to be ready
 * and a minute, was stopped, by a restart or a crash; each is taken over as
 * another change would take it, then ended Failed, saying why, so that the
 * function's next change may run and its record and its Deployment agree:
 * - a create's function is ERROR, scaled to zero, as a create that failed;
 * - a working function's version, the one its record describes, is rolled out
 *   again (an update stopped mid-rollout), or deployed again when the cluster
 *   holds none (a delete stopped halfway); a failure of that leaves the
 *   function ERROR, saying both;
 * - a function in ERROR is scaled to zero, as it was, its error kept.
 * Each end is in the audit log.
 */
@Injectable()
export class StoppedChanges implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StoppedChanges.name);
  private timer?: NodeJS.Timeout;
  /** The turn under way: a slow one isn't started again when the next minute comes. */
  private running?: Promise<unknown>;

  constructor(
    private readonly dataSource: DataSource,
    private readonly functions: FunctionsService,
    @Inject(ORCHESTRATOR) private readonly orchestrator: Orchestrator,
    private readonly plans: PlansService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    // At start, in the background, then each minute.
    this.runInBackground();
    this.timer = setInterval(() => this.runInBackground(), SWEEP_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private runInBackground(): void {
    if (this.running) return;
    this.running = this.sweep()
      .catch((error: unknown) => this.logger.error(`The sweep of stopped changes failed: ${describeError(error)}`))
      .finally(() => (this.running = undefined));
  }

  /** One turn: each change under way past its bound. A turn that comes while another runs, here or in another backend, does nothing. */
  async sweep(now = new Date()): Promise<StoppedChangesReport> {
    const report: StoppedChangesReport = { ended: 0, rolledOut: 0, failures: 0 };
    const bound = changeBoundMs(readyTimeoutMs(this.config));
    await withJobLock(this.dataSource, SWEEP_LOCK, async () => {
      const stopped = await this.dataSource.getRepository(Function).find({
        where: [
          { updateStatus: UpdateStatus.IN_PROGRESS, updateStartedAt: LessThan(new Date(now.getTime() - bound)) },
          { updateStatus: UpdateStatus.IN_PROGRESS, updateStartedAt: IsNull() },
        ],
      });
      for (const function_ of stopped) {
        try {
          await this.endStopped(function_, now, bound, report);
        } catch (error) {
          report.failures++;
          this.logger.error(`Could not end the stopped change of function ${function_.id}: ${describeError(error)}`);
        }
      }
    });
    if (report.ended || report.failures) {
      this.logger.warn(
        `Changes a stopped backend left: ${report.ended} ended Failed, ${report.rolledOut} of them rolled out again as before; ${report.failures} failure(s)`,
      );
    }
    return report;
  }

  /** Takes the stopped change over, undoes what it left on the cluster, and ends it Failed; nothing when another change took it first. */
  private async endStopped(function_: Function, now: Date, bound: number, report: StoppedChangesReport): Promise<void> {
    const change = await takeFunction(this.dataSource.manager, function_, now, bound);
    if (!change) return;
    const { reason, fields, rolledOut } = await this.undo(function_);
    if (!(await this.end(change, function_, reason, fields))) return;
    report.ended++;
    if (rolledOut) report.rolledOut++;
  }

  /** Undoes what a stopped change left on the cluster: why it ended, and what of its function's record changes with it. */
  private async undo(function_: Function): Promise<Undone> {
    if (function_.status === FunctionStatus.CREATING) {
      await this.functions.releaseInstances(function_);
      return { reason: STOPPED_REASONS.create, fields: { status: FunctionStatus.ERROR, error: STOPPED_REASONS.create } };
    }
    if (function_.status !== FunctionStatus.ACTIVE) {
      await this.functions.releaseInstances(function_);
      return { reason: STOPPED_REASONS.notActive };
    }
    try {
      await this.rollOutRecord(function_);
      return { reason: STOPPED_REASONS.undone, rolledOut: true };
    } catch (error) {
      const reason = `The backend stopped during this change, and the version before it couldn't be rolled out again: ${platformFailure(this.logger, 'Rolling the function out again', error)}`;
      await this.functions.releaseInstances(function_);
      return { reason, fields: { status: FunctionStatus.ERROR, error: reason } };
    }
  }

  /**
   * The version the record describes, rolled out again, or deployed again when
   * the cluster has none. Even when the cluster may run it already: what it
   * tells of a Deployment, its code and its environment, doesn't say whether
   * it runs the record's memory, timeout and handler.
   */
  private async rollOutRecord(function_: Function): Promise<void> {
    const workload = await this.functions.runningWorkload(function_.id);
    if (!workload) throw new Error(`function ${function_.id} has no package to run: it is no longer ACTIVE`);
    const held = (await this.orchestrator.workloads(function_)).some((deployment) => deployment.version === undefined);
    await this.plans.withTenant(function_.accountId, (tenant) => (held ? this.orchestrator.update(workload, tenant) : this.orchestrator.deploy(workload, tenant)));
    await this.orchestrator.waitUntilReady(workload, readyTimeoutMs(this.config));
  }

  /** Ends the change Failed for its reason, its function's other fields with it, in the audit log: false, saving nothing, once another change took it. */
  private async end(change: ChangeUnderWay, function_: Function, reason: string, fields: UndoneFields = {}): Promise<boolean> {
    if (!(await endChange(this.dataSource.manager, change, failedFor(reason), fields))) return false;
    await this.audit.record({
      accountId: function_.accountId,
      action: 'function.update',
      resource: `function:${function_.id}`,
      details: { outcome: `stopped by the backend, ended Failed: ${reason}` },
    });
    return true;
  }
}
