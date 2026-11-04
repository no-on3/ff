import { ConflictException, PreconditionFailedException } from '@nestjs/common';
import { EntityManager, IsNull, LessThan, Not } from 'typeorm';
import { Function, FunctionStatus, UpdateStatus } from './entities/function.entity';

/**
 * How long past its rollout's bound a change may still be saving its outcome.
 * A change's rollout, and an update's rollback after it, each wait for an
 * instance at most the ready timeout: a change older than both and this was
 * stopped, by a restart of the backend, and another may take its function.
 */
const CHANGE_MARGIN_MS = 60_000;

/** How long a change holds its function at most, the ready timeout given. */
export const changeBoundMs = (readyTimeoutMs: number): number => 2 * readyTimeoutMs + CHANGE_MARGIN_MS;

/** The change that holds a function: the function, and when the change started, which only it knows. */
export interface ChangeUnderWay {
  functionId: string;
  startedAt: Date;
}

/** How a change ended, as Lambda's LastUpdateStatus: live, or failed for a reason. */
export type ChangeOutcome = { updateStatus: UpdateStatus.SUCCESSFUL } | { updateStatus: UpdateStatus.FAILED; updateReason: string };

/** A change that went live. */
export const SUCCEEDED: ChangeOutcome = { updateStatus: UpdateStatus.SUCCESSFUL };

/** A change that failed, for this reason. */
export const failedFor = (reason: string): ChangeOutcome => ({ updateStatus: UpdateStatus.FAILED, updateReason: reason });

/** The record's fields that say how its last change went, once it ended. */
export const endedAs = (outcome: ChangeOutcome): Pick<Function, 'updateStatus' | 'updateReason' | 'updateStartedAt'> => ({
  updateStatus: outcome.updateStatus,
  updateReason: outcome.updateStatus === UpdateStatus.FAILED ? outcome.updateReason : null,
  updateStartedAt: null,
});

/** Whether a change holds the function now: one under way, and not past its bound. */
export function isUnderWay(function_: Pick<Function, 'updateStatus' | 'updateStartedAt'>, now: Date, boundMs: number): boolean {
  if (function_.updateStatus !== UpdateStatus.IN_PROGRESS || !function_.updateStartedAt) return false;
  return now.getTime() - function_.updateStartedAt.getTime() <= boundMs;
}

/**
 * A change refused while another holds its function, as Lambda refuses one: the
 * rollouts would race on the cluster, and the later save undo the other's.
 * Lambda's operations say it in Lambda's words.
 */
export class ChangeUnderWayException extends ConflictException {
  constructor(readonly function_: Pick<Function, 'accountId' | 'name' | 'status'>) {
    super(
      function_.status === FunctionStatus.CREATING
        ? `The function ${function_.name} is being created: change or delete it once it is ACTIVE, or ERROR`
        : `The function ${function_.name} is being changed: change or delete it once that change is live, or rolled back`,
    );
  }
}

/** A change given the revision its caller read, once another came since: Lambda's PreconditionFailedException. */
export const revisionMoved = (sent: string, function_: Pick<Function, 'name' | 'revisionId'>): PreconditionFailedException =>
  new PreconditionFailedException(
    `RevisionId ${sent} isn't the function ${function_.name}'s, ${function_.revisionId}: another change came since it was read. Read the function again, then change it`,
  );

/**
 * Takes the function for a change, in one conditional UPDATE, so that two
 * changes never both take it: unless another change holds it, or its record
 * is no longer the one read, its revision having moved on. Null then.
 */
export async function takeFunction(
  manager: EntityManager,
  function_: Pick<Function, 'id' | 'revisionId'>,
  now: Date,
  boundMs: number,
): Promise<ChangeUnderWay | null> {
  const read = { id: function_.id, revisionId: function_.revisionId };
  const { affected } = await manager.update(
    Function,
    [
      { ...read, updateStatus: Not(UpdateStatus.IN_PROGRESS) },
      { ...read, updateStartedAt: IsNull() },
      { ...read, updateStartedAt: LessThan(new Date(now.getTime() - boundMs)) },
    ],
    { updateStatus: UpdateStatus.IN_PROGRESS, updateReason: null, updateStartedAt: now },
  );
  return affected ? { functionId: function_.id, startedAt: now } : null;
}

/**
 * Saves how the change ended, unless it no longer holds its function: another
 * took it over, past its bound, or deleted it. `fields` saves more of it: a
 * create's status and error. Whether it saved.
 */
export async function endChange(
  manager: EntityManager,
  change: ChangeUnderWay,
  outcome: ChangeOutcome,
  fields: Partial<Pick<Function, 'status' | 'error'>> = {},
): Promise<boolean> {
  const { affected } = await manager.update(
    Function,
    { id: change.functionId, updateStatus: UpdateStatus.IN_PROGRESS, updateStartedAt: change.startedAt },
    { ...fields, ...endedAs(outcome) },
  );
  return Boolean(affected);
}
