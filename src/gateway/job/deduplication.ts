/** Deduplication check — queries job store for active duplicates within a time window. */
import type { PgQuery } from './store.js';

/**
 * Check if a job with the same dedup key already exists in active states within the window.
 * Queued jobs remain duplicates beyond the window so failed deliveries can be retried.
 * Returns the existing job ID if duplicate, null otherwise.
 */
export async function isDuplicate(
  pool: PgQuery,
  tenantId: string,
  domain: string,
  dedupKey: string,
  windowMs: number,
): Promise<string | null> {
  const { rows } = await pool.query(
    `SELECT id FROM jobs
     WHERE tenant_id = $1
       AND domain = $2
       AND status IN ('queued', 'running', 'waiting', 'action_pending', 'action_executing')
       AND input->'options'->>'dedupKey' = $3
       AND (created_at >= statement_timestamp() - ($4::bigint * interval '1 millisecond') OR status = 'queued')
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, domain, dedupKey, windowMs],
  );
  return rows.length > 0 ? (rows[0].id as string) : null;
}
