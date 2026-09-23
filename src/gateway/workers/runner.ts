/** BullMQ dispatch with an execution deadline, cancellation, and fenced late writes. */
import { randomUUID } from 'node:crypto';
import { Worker } from 'bullmq';
import type { Job as BullJob } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PgPool } from '../job/store.js';
import { getJob, updateJob } from '../job/store.js';
import { isTerminal, transitionJob, JobConflictError } from '../job/lifecycle.js';
import type { Job, DomainType } from '../job/types.js';
import type { DomainQueueConfig } from '../job/queue-config.js';
import { getQueueConfig } from '../job/queue-config.js';
import { withJobExecution, untilAborted, type JobExecution } from '../job/execution-context.js';
import { reconcileQueueFailures } from '../job/outbox.js';
export type RedisConnection = Redis;
export interface DomainHandler {
  readonly domain: DomainType;
  process(job: Job, pool: PgPool, execution?: JobExecution): Promise<void>;
  resume?(job: Job, input: unknown, pool: PgPool, execution?: JobExecution): Promise<void>;
}
export interface WorkerOptions {
  concurrency?: number;
  lockDuration?: number;
  timeoutMs?: number;
  queueConfig?: DomainQueueConfig;
}
export function createDomainWorker(handler: DomainHandler, connection: RedisConnection, pool: PgPool, opts: WorkerOptions = {}): Worker {
  const config = opts.queueConfig ?? getQueueConfig(handler.domain);
  const timeoutMs = opts.timeoutMs ?? config.timeout;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid worker execution timeout');
  const worker = new Worker(
    `secops-${handler.domain}`,
    async (bullJob: BullJob) => {
      const jobId = bullJob.data.jobId as string;
      let job = await getJob(pool, jobId);
      if (!job) throw new Error(`Job ${jobId} not found in database`);
      if (isTerminal(job.status) || job.status === 'waiting' || job.status === 'action_pending') return;
      if (bullJob.id && bullJob.id !== (job.deliveryId ?? job.id)) return;
      if (job.domain !== handler.domain) throw new Error('Worker domain mismatch');
      try {
        if (job.status === 'failed') job = await transitionJob(pool, job, 'queued', { error: null });
        if (job.status === 'queued') job = await transitionJob(pool, job, 'running');
        const claimed = await updateJob(pool, job.id, { executionToken: randomUUID() }, job);
        if (!claimed) throw new JobConflictError();
        job = claimed;
      } catch (error) { if (error instanceof JobConflictError) return; throw error; }
      const controller = new AbortController();
      const execution = { jobId, token: job.executionToken!, signal: controller.signal };
      const timer = setTimeout(() => controller.abort(new Error(`Worker execution deadline exceeded: ${timeoutMs}ms`)), timeoutMs);
      let polling = false;
      const cancelPoll = setInterval(() => {
        if (polling || controller.signal.aborted) return;
        polling = true;
        void getJob(pool, jobId).then(current => {
          if (!current || current.executionToken !== execution.token || !['running', 'action_executing'].includes(current.status)) {
            controller.abort(new Error('Job execution is no longer active'));
          }
        }).catch(error => controller.abort(error)).finally(() => { polling = false; });
      }, 1000);
      try {
        await untilAborted(() => withJobExecution(execution, () => job!.pendingInput && handler.resume
          ? handler.resume(job!, job!.pendingInput, pool, execution)
          : handler.process(job!, pool, execution)), controller.signal);
      } catch (error) {
        const current = await getJob(pool, jobId);
        if (current?.executionToken === execution.token && ['running', 'action_executing'].includes(current.status)) {
          try { await transitionJob(pool, current, 'failed', {
            error: { message: error instanceof Error ? error.message : String(error) },
            notification: { type: 'failed', error: error instanceof Error ? error.message : String(error) },
          }); } catch (conflict) { if (!(conflict instanceof JobConflictError)) throw conflict; }
        }
        throw error;
      } finally { clearTimeout(timer); clearInterval(cancelPoll); }
    },
    { connection, concurrency: opts.concurrency ?? config.concurrency, lockDuration: opts.lockDuration ?? 30_000 },
  );
  worker.on('error', error => console.error(`[worker:${handler.domain}] Error:`, error.message));
  worker.on('failed', (job, error) => {
    console.error(`[worker:${handler.domain}] Job ${job?.id} failed:`, error.message);
    void untilAborted(() => reconcileQueueFailures(pool, connection, handler.domain), AbortSignal.timeout(5000))
      .catch(error => console.error('[worker:reconcile]', String(error)));
  });
  return worker;
}

/**
 * Domain handler registry for workers.
 */
export class DomainHandlerRegistry {
  private handlers = new Map<string, DomainHandler>();

  register(handler: DomainHandler): void {
    if (this.handlers.has(handler.domain)) {
      throw new Error(`Domain handler already registered: ${handler.domain}`);
    }
    this.handlers.set(handler.domain, handler);
  }

  get(domain: string): DomainHandler | undefined {
    return this.handlers.get(domain);
  }

  getOrThrow(domain: string): DomainHandler {
    const handler = this.handlers.get(domain);
    if (!handler) throw new Error(`Domain handler not found: ${domain}`);
    return handler;
  }

  list(): string[] {
    return Array.from(this.handlers.keys());
  }
}
