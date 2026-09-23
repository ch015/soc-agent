/** BullMQ Queue producer — one queue per domain. */
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import type { DomainType, Job } from './types.js';
import { getQueueConfig } from './queue-config.js';
export { getQueueConfig } from './queue-config.js';

export type RedisConnection = Redis;

let byConnection = new WeakMap<RedisConnection, Map<string, Queue>>();
const queues = new Set<Queue>();

function getQueueName(domain: DomainType): string {
  return `secops-${domain}`;
}

export function getOrCreateQueue(domain: DomainType, connection: RedisConnection): Queue {
  const name = getQueueName(domain);
  let managed = byConnection.get(connection);
  if (!managed) { managed = new Map(); byConnection.set(connection, managed); }
  let queue = managed.get(name);
  if (!queue) {
    queue = new Queue(name, { connection });
    managed.set(name, queue); queues.add(queue);
  }
  return queue;
}

export interface EnqueueOptions {
  deliveryId?: string;
  priority?: number;
  delay?: number;
  attempts?: number;
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
}

/**
 * Enqueue a job into the domain-specific BullMQ queue.
 * Returns the BullMQ job ID.
 */
export async function enqueue(
  domain: DomainType,
  job: Job,
  connection: RedisConnection,
  opts: EnqueueOptions = {},
): Promise<string> {
  const queue = getOrCreateQueue(domain, connection);
  const config = getQueueConfig(domain);
  const bullJob = await queue.add(
    `${domain}-job`,
    { jobId: job.id, tenantId: job.tenantId, domain: job.domain },
    {
      jobId: opts.deliveryId ?? job.deliveryId ?? job.id,
      priority: opts.priority ?? (config.priority ? job.priority : undefined),
      delay: opts.delay,
      attempts: opts.attempts ?? config.retry.attempts,
      backoff: opts.backoff ?? config.retry.backoff,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
  );
  return bullJob.id!;
}

/**
 * Close all managed queues. Call on graceful shutdown.
 */
export async function closeAllQueues(): Promise<void> {
  const all = Array.from(queues.values());
  await Promise.all(all.map((q) => q.close()));
  queues.clear(); byConnection = new WeakMap();
}
