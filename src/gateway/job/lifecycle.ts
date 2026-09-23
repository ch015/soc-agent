/** Job lifecycle state transition validation and event emission. */
import type { PgPool } from './store.js';
import { updateJob, insertJobEvent } from './store.js';
import { currentJobExecution } from './execution-context.js';
import { transaction } from './transaction.js';
import { saveExecutionDelivery, saveCallbackDelivery } from './delivery-store.js';
import type { Job, JobStatus, ResultPayload } from './types.js';

/**
 * Valid transitions map — exact per design §6.2.
 * Keys are current states; values are arrays of valid next states.
 */
export const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  rejected: [],
  queued: ['running', 'cancelled'],
  running: ['waiting', 'completed', 'failed', 'cancelled', 'action_pending', 'action_executing'],
  waiting: ['running', 'failed', 'cancelled'],
  completed: [],
  failed: ['queued'],
  cancelled: [],
  action_pending: ['action_executing', 'cancelled', 'completed'],
  action_executing: ['completed', 'failed'],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus,
  ) {
    super(`Invalid job transition: ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function isTerminal(status: JobStatus): boolean {
  return VALID_TRANSITIONS[status].length === 0;
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

export class JobConflictError extends Error { constructor() { super('Job state changed; reload before retrying'); this.name = 'JobConflictError'; } }

export interface TransitionOptions {
  deliveryId?: string;
  notification?: ResultPayload;
  progress?: Record<string, unknown> | null;
  result?: Record<string, unknown> | null;
  error?: Record<string, unknown> | null;
  pendingInput?: Record<string, unknown> | null;
}

/**
 * Transition a job to a new status. Validates the transition, updates the row,
 * and emits a job_event.
 */
export async function transitionJob(
  pool: PgPool,
  job: Job,
  to: JobStatus,
  opts: TransitionOptions = {},
): Promise<Job> {
  currentJobExecution(job.id);
  if (!canTransition(job.status, to)) {
    throw new InvalidTransitionError(job.status, to);
  }

  const updateFields: Parameters<typeof updateJob>[2] = {
    status: to,
  };

  if (opts.deliveryId !== undefined) updateFields.deliveryId = opts.deliveryId;
  if (!['running', 'action_executing'].includes(to)) updateFields.executionToken = null;
  if (to === 'queued' || to === 'running') updateFields.completedAt = null;

  if (opts.progress !== undefined) updateFields.progress = opts.progress;
  if (opts.result !== undefined) updateFields.result = opts.result;
  if (opts.error !== undefined) updateFields.error = opts.error;
  if (opts.pendingInput !== undefined) updateFields.pendingInput = opts.pendingInput;

  // Set timestamps based on transition
  if (to === 'running' && job.status !== 'waiting') {
    updateFields.startedAt = new Date();
    updateFields.attempts = job.attempts + 1;
  }
  if (to === 'completed' || to === 'failed' || to === 'cancelled') {
    updateFields.completedAt = new Date();
  }

  return transaction(pool, async client => {
    const updated = await updateJob(client, job.id, updateFields, job);
    if (!updated) throw new JobConflictError();

    // Emit event
    const eventType = mapStatusToEventType(to);
    const eventPayload: Record<string, unknown> = {
      status: to,
      updatedAt: updated.updatedAt.toISOString(),
    };
    if (opts.progress) eventPayload.progress = opts.progress;
    if (opts.result) eventPayload.result = opts.result;
    if (opts.error) eventPayload.error = opts.error;
    if (opts.pendingInput) eventPayload.pendingInput = opts.pendingInput;

    await insertJobEvent(client, job.id, eventType, eventPayload);
    if (opts.deliveryId) await saveExecutionDelivery(client, updated, opts.deliveryId);
    if (opts.notification) await saveCallbackDelivery(client, updated, opts.notification);

    return updated;
  });
}

/**
 * Emit a progress event without changing job status.
 */
export async function emitProgress(
  pool: PgPool,
  jobId: string,
  progress: { phase: string; percent: number; detail?: string },
): Promise<void> {
  if (!await updateJob(pool, jobId, { progress })) throw new JobConflictError();
  await insertJobEvent(pool, jobId, 'progress', progress);
}

function mapStatusToEventType(status: JobStatus): string {
  switch (status) {
    case 'running':
      return 'status';
    case 'waiting':
      return 'waiting';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'status';
    default:
      return 'status';
  }
}
