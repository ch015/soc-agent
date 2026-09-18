/** Deduplication check — queries job store for active duplicates within a time window. */
import type { PgPool } from './store.js';

/**
 * Check if a job with the same dedup key already exists in active states within the window.
 * Returns the existing job ID if duplicate, null otherwise.
 */
export async function isDuplicate(
  pool: PgPool,
  tenantId: string,
  domain: string,
  dedupKey: string,
  windowMs: number,
): Promise<string | null> {
  const windowStart = new Date(Date.now() - windowMs).toISOString();
  const { rows } = await pool.query(
    `SELECT id FROM jobs
     WHERE tenant_id = $1
       AND domain = $2
       AND status IN ('queued', 'running', 'waiting')
       AND input->>'dedupKey' = $3
       AND created_at >= $4
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, domain, dedupKey, windowStart],
  );
  return rows.length > 0 ? (rows[0].id as string) : null;
}
