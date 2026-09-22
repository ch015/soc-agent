import { checkQuota } from '../auth/tenant.js';
import type { SocSignal } from '../../runtime/investigation/signal.js';
import type { CanonicalRequest, Job } from './types.js';
import { createJob, findTenantById, getJob, type PgPool, type PgQuery } from './store.js';
import { isDuplicate } from './deduplication.js';
import { getQueueConfig } from './queue-config.js';
import { enqueue, type RedisConnection } from './queue.js';

export type JobAdmission = { kind: 'created' | 'duplicate' | 'correlated'; job: Job };

/** Serialize both HTTP entry points by tenant, including quota and durable dedup. */
export async function admitSocJob(pool: PgPool, input: {
  tenantId: string; request: CanonicalRequest; priority?: number; signal?: SocSignal;
}): Promise<JobAdmission> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE', [input.tenantId]);
    // Reload quota after acquiring the row lock; authentication can predate an update.
    const tenant = await findTenantById(client, input.tenantId);
    if (!tenant) throw new Error('Authenticated tenant no longer exists');
    const windowMs = getQueueConfig('soc').deduplication!.windowMs;
    let existing: JobAdmission | undefined;
    if (input.signal) {
      existing = await findSignalAdmission(client, tenant.id, input.signal, windowMs);
    } else if (typeof input.request.options?.dedupKey === 'string') {
      const id = await isDuplicate(client, tenant.id, 'soc', input.request.options.dedupKey, windowMs);
      const job = id ? await getJob(client, id) : null;
      if (job) existing = { kind: 'duplicate', job };
    }
    // A retry reuses its admission even when the tenant has since reached quota.
    if (existing) { await client.query('COMMIT'); return existing; }
    await checkQuota(client, tenant, 'soc');
    const job = await createJob(client, { tenantId: tenant.id, domain: 'soc', input: input.request,
      callback: input.request.callback, priority: input.priority });
    await client.query('COMMIT');
    return { kind: 'created', job };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (cause) { broken = cause instanceof Error ? cause : new Error(String(cause)); }
    throw error;
  } finally { client.release(broken); }
}

async function findSignalAdmission(db: PgQuery, tenantId: string, signal: SocSignal, windowMs: number): Promise<JobAdmission | undefined> {
  // Queued admissions remain retryable after the normal five-minute window when
  // Redis delivery failed. Database receipts survive cache loss and gateway restarts.
  const recent = "(created_at >= statement_timestamp() - ($2::bigint * interval '1 millisecond') OR status = 'queued')";
  const exact = await db.query<{ id: string }>(
    `SELECT id FROM jobs WHERE tenant_id = $1 AND domain = 'soc' AND ${recent}
      AND input->'metadata'->>'signalId' = $3 ORDER BY created_at DESC LIMIT 1`, [tenantId, windowMs, signal.signalId]);
  if (exact.rows[0]) {
    const job = await getJob(db, exact.rows[0].id);
    if (job) return { kind: 'duplicate', job };
  }
  if (!signal.rule) return;
  const correlated = await db.query<{ id: string }>(
    `SELECT id FROM jobs WHERE tenant_id = $1 AND domain = 'soc'
      AND created_at >= statement_timestamp() - ($2::bigint * interval '1 millisecond')
      AND status NOT IN ('failed', 'cancelled', 'rejected')
      AND input->'options'->'signal'->'subject'->>'type' = $3
      AND input->'options'->'signal'->'subject'->>'value' = $4
      AND input->'options'->'signal'->'rule'->>'id' = $5 ORDER BY created_at DESC LIMIT 1`,
    [tenantId, windowMs, signal.subject.type, signal.subject.value, signal.rule.id]);
  if (correlated.rows[0]) {
    const job = await getJob(db, correlated.rows[0].id);
    if (job) return { kind: 'correlated', job };
  }
}

export class QueueDeliveryError extends Error {
  constructor(public readonly jobId: string, cause?: unknown) {
    super('Job stored; queue delivery is unavailable.', { cause });
  }
}

/** Never enqueue uncommitted rows. Retried queued admissions reuse the BullMQ ID. */
export async function deliverAdmission(admission: JobAdmission, redis: RedisConnection): Promise<void> {
  if (admission.job.status !== 'queued') return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      enqueue('soc', admission.job, redis, { priority: admission.job.priority }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Queue delivery deadline exceeded')), 5000); }),
    ]);
  } catch (cause) { throw new QueueDeliveryError(admission.job.id, cause); }
  finally { clearTimeout(timer); }
}
