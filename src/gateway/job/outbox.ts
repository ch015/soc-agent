import type { PgPool } from './store.js';
import { getJob } from './store.js';
import { transaction } from './transaction.js';
import { enqueue, getOrCreateQueue, type RedisConnection } from './queue.js';
import { resultRouter } from '../result/router.js';
import { untilAborted } from './execution-context.js';
import { JobConflictError, transitionJob } from './lifecycle.js';
import type { Job, ResultPayload, DomainType } from './types.js';

/** Row locks serialize dispatchers; failed deliveries remain durable with bounded backoff. */
export async function dispatchOutbox(pool: PgPool, redis: RedisConnection, limit = 20): Promise<number> {
  let delivered = 0;
  for (let i = 0; i < limit; i++) {
    const found = await transaction(pool, async db => {
      const { rows } = await db.query(`SELECT * FROM gateway_outbox WHERE delivered_at IS NULL AND available_at <= now()
        ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1`);
      const row = rows[0];
      if (!row) return false;
      try {
        if (row.kind === 'execution') {
          const job = await getJob(db, row.job_id);
          const id = row.payload.deliveryId as string;
          if (job && (job.deliveryId ?? job.id) === id && ['queued', 'running', 'action_executing'].includes(job.status)) {
            await untilAborted(() => enqueue(job.domain, job, redis, { deliveryId: id }), AbortSignal.timeout(5000));
          }
        } else {
          const { job, result } = row.payload as { job: Job; result: ResultPayload };
          await untilAborted(() => resultRouter.route(job, result, row.id), AbortSignal.timeout(15_000));
        }
        await db.query('UPDATE gateway_outbox SET delivered_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1', [row.id]);
        delivered++;
      } catch (error) {
        await db.query(`UPDATE gateway_outbox SET attempts=attempts+1,last_error=$2,
          available_at=now()+($3::int * interval '1 millisecond') WHERE id=$1`,
        [row.id, String(error).slice(0, 1000), Math.min(60_000, 1000 * 2 ** Math.min(Number(row.attempts), 6))]);
      }
      return true;
    });
    if (!found) break;
  }
  return delivered;
}

const reconciliationCursors = new WeakMap<PgPool, Map<DomainType, string>>();

/** Handles failures raised by BullMQ without re-entering the processor (including stalled exhaustion). */
export async function reconcileQueueFailures(pool: PgPool, redis: RedisConnection, domain: DomainType, signal: AbortSignal = AbortSignal.timeout(5000)): Promise<void> {
  const queue = getOrCreateQueue(domain, redis);
  let cursors = reconciliationCursors.get(pool);
  if (!cursors) { cursors = new Map(); reconciliationCursors.set(pool, cursors); }
  const cursor = cursors.get(domain) ?? null;
  const { rows } = await pool.query(`SELECT id FROM jobs WHERE domain=$1 AND status IN ('running','action_executing')
    AND ($2::uuid IS NULL OR id > $2::uuid) ORDER BY id LIMIT 200`, [domain, cursor]);
  if (!rows.length) cursors.delete(domain);
  for (const row of rows) {
    signal.throwIfAborted();
    cursors.set(domain, row.id);
    const job = await getJob(pool, row.id);
    if (!job || !['running', 'action_executing'].includes(job.status)) continue;
    const delivery = await untilAborted(() => queue.getJob(job.deliveryId ?? job.id), signal);
    if (!delivery || !['failed', 'completed'].includes(await untilAborted(() => delivery.getState(), signal))) continue;
    try {
      await transitionJob(pool, job, 'failed', { error: { message: delivery.failedReason || 'Queue delivery ended without a terminal database receipt', category: 'queue_reconciliation' },
        notification: { type: 'failed', error: 'Execution stopped; inspect the retained job and queue receipt.' } });
    } catch (error) { if (!(error instanceof JobConflictError)) throw error; }
  }
}

export function startDeliveryMaintenance(pool: PgPool, redis: RedisConnection, domain: DomainType, intervalMs = 1000): () => Promise<void> {
  let active: Promise<unknown> | undefined;
  const tick = () => {
    if (active) return;
    active = (async () => { await dispatchOutbox(pool, redis); await untilAborted(() => reconcileQueueFailures(pool, redis, domain), AbortSignal.timeout(5000)); })()
      .catch(error => console.error('[delivery-maintenance]', String(error))).finally(() => { active = undefined; });
  };
  const timer = setInterval(tick, intervalMs); timer.unref(); tick();
  return async () => { clearInterval(timer); await active; };
}
