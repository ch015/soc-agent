/** Generic BullMQ Worker bootstrap per domain. DomainHandler interface. */
import { Worker } from 'bullmq';
import type { Job as BullJob } from 'bullmq';
import type { Redis } from 'ioredis';

import type { PgPool } from '../job/store.js';
import { getJob } from '../job/store.js';
import { isTerminal, transitionJob } from '../job/lifecycle.js';
import type { Job, DomainType } from '../job/types.js';
import type { DomainQueueConfig } from '../job/queue-config.js';

export type RedisConnection = Redis;

/**
 * DomainHandler — extensibility point for new domains.
 * SOC worker handlers implement this interface.
 */
export interface DomainHandler {
  readonly domain: DomainType;
  process(job: Job, pool: PgPool): Promise<void>;
  resume?(job: Job, input: unknown, pool: PgPool): Promise<void>;
}

export interface WorkerOptions {
  concurrency?: number;
  lockDuration?: number;
  queueConfig?: DomainQueueConfig;
}

/**
 * Create and start a BullMQ Worker for a given domain handler.
 * The worker fetches the full Job from PostgreSQL and delegates to the handler.
 */
export function createDomainWorker(
  handler: DomainHandler,
  connection: RedisConnection,
  pool: PgPool,
  opts: WorkerOptions = {},
): Worker {
  const queueName = `secops-${handler.domain}`;
  const concurrency = opts.concurrency ?? opts.queueConfig?.concurrency ?? 5;
  const lockDuration = opts.queueConfig?.timeout ?? opts.lockDuration ?? 900_000;

  const worker = new Worker(
    queueName,
    async (bullJob: BullJob) => {
      const jobId = bullJob.data.jobId as string;
      const job = await getJob(pool, jobId);
      if (!job) {
        throw new Error(`Job ${jobId} not found in database`);
      }

      // Late/repeated deliveries must not restart terminal or unanswered work.
      if (isTerminal(job.status) || job.status === 'waiting' || job.status === 'action_pending') return;
      if (job.status === 'failed') {
        await transitionJob(pool, job, 'queued', { error: null });
        job.status = 'queued';
      }
      if (job.status === 'queued') {
        await transitionJob(pool, job, 'running');
        job.status = 'running';
      }

      try {
        // If job was waiting and has input, call resume
        if (job.pendingInput && handler.resume) {
          await handler.resume(job, job.pendingInput, pool);
        } else {
          await handler.process(job, pool);
        }
      } catch (err) {
        // Transition to failed
        const refetched = await getJob(pool, jobId);
        if (refetched && refetched.status === 'running') {
          await transitionJob(pool, refetched, 'failed', {
            error: {
              message: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
            },
          });
        }
        throw err;
      }
    },
    {
      connection,
      concurrency,
      lockDuration,
    },
  );

  worker.on('error', (err) => {
    console.error(`[worker:${handler.domain}] Error:`, err.message);
  });

  worker.on('failed', (bullJob, err) => {
    console.error(`[worker:${handler.domain}] Job ${bullJob?.id} failed:`, err.message);
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
