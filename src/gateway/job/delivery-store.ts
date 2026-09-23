import type { PgQuery } from './store.js';
import type { Job, ResultPayload } from './types.js';

export async function saveExecutionDelivery(db: PgQuery, job: Job, deliveryId: string): Promise<void> {
  await db.query(`INSERT INTO gateway_outbox(id, job_id, kind, payload)
    VALUES ($1,$2,'execution',$3) ON CONFLICT(id) DO NOTHING`,
  [`execution:${deliveryId}`, job.id, JSON.stringify({ deliveryId })]);
}
export async function saveCallbackDelivery(db: PgQuery, job: Job, payload: ResultPayload): Promise<void> {
  if (job.callback.type === 'poll') return;
  const id = `callback:${job.id}:${job.version ?? 0}:${payload.type}`;
  await db.query(`INSERT INTO gateway_outbox(id, job_id, kind, payload)
    VALUES ($1,$2,'callback',$3) ON CONFLICT(id) DO NOTHING`,
  [id, job.id, JSON.stringify({ job, result: payload })]);
}
