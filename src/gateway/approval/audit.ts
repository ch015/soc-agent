/** ApprovalAuditEvent type + appendAuditEvent() to PostgreSQL (append-only). */
import type { PgPool } from '../job/store.js';
import type { ApprovalDecision } from './policy.js';

export interface ApprovalAuditEvent {
  jobId: string;
  actionKey: string;
  actionType: string;
  decision: ApprovalDecision;
  decidedBy: string;
  decidedAt: string;
  policyVersion: string;
  rationale?: string;
  evidence: {
    signalSeverity: string;
    analysisConfidence: number;
    matchedPolicyRule: string;
  };
}

export interface StoredAuditEvent extends ApprovalAuditEvent {
  id: string;
  createdAt: Date;
}

/**
 * Append an audit event to the approval_events table (append-only, never update/delete).
 */
export async function appendAuditEvent(
  pool: PgPool,
  event: ApprovalAuditEvent,
): Promise<StoredAuditEvent> {
  const { rows } = await pool.query(
    `INSERT INTO approval_events (
      job_id, action_key, action_type, decision, decided_by, decided_at,
      policy_version, rationale, evidence
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *`,
    [
      event.jobId,
      event.actionKey,
      event.actionType,
      event.decision,
      event.decidedBy,
      event.decidedAt,
      event.policyVersion,
      event.rationale ?? null,
      JSON.stringify(event.evidence),
    ],
  );

  return mapAuditRow(rows[0]);
}

/**
 * List audit events for a job.
 */
export async function listAuditEvents(
  pool: PgPool,
  opts: { jobId?: string; tenantId?: string; from?: string; to?: string; limit?: number; offset?: number },
): Promise<StoredAuditEvent[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.jobId) {
    conditions.push(`ae.job_id = $${idx++}`);
    params.push(opts.jobId);
  }
  if (opts.tenantId) {
    conditions.push(`j.tenant_id = $${idx++}`);
    params.push(opts.tenantId);
  }
  if (opts.from) {
    conditions.push(`ae.decided_at >= $${idx++}`);
    params.push(opts.from);
  }
  if (opts.to) {
    conditions.push(`ae.decided_at <= $${idx++}`);
    params.push(opts.to);
  }

  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  params.push(limit, offset);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT ae.* FROM approval_events ae
     JOIN jobs j ON j.id = ae.job_id
     ${where}
     ORDER BY ae.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );

  return rows.map(mapAuditRow);
}

function mapAuditRow(row: Record<string, unknown>): StoredAuditEvent {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    actionKey: row.action_key as string,
    actionType: row.action_type as string,
    decision: row.decision as ApprovalDecision,
    decidedBy: row.decided_by as string,
    decidedAt: row.decided_at as string,
    policyVersion: row.policy_version as string,
    rationale: row.rationale as string | undefined,
    evidence: row.evidence as StoredAuditEvent['evidence'],
    createdAt: new Date(row.created_at as string),
  };
}
