/** PostgreSQL CRUD for jobs + job_events tables. */
import pg from 'pg';

import type { Job, JobEvent, JobStatus, CanonicalRequest, ResultCallback } from './types.js';

const { Pool } = pg;

export type PgPool = InstanceType<typeof Pool>;

export function createPool(connectionString: string): PgPool {
  return new Pool({ connectionString, max: 20 });
}

// ─── Job CRUD ───────────────────────────────────────────────────────────────

export interface CreateJobParams {
  tenantId: string;
  domain: string;
  input: CanonicalRequest;
  callback: ResultCallback;
  priority?: number;
}

export async function createJob(pool: PgPool, params: CreateJobParams): Promise<Job> {
  const { tenantId, domain, input, callback, priority = 3 } = params;
  const { rows } = await pool.query(
    `INSERT INTO jobs (tenant_id, domain, input, callback, priority, status)
     VALUES ($1, $2, $3, $4, $5, 'queued')
     RETURNING *`,
    [tenantId, domain, JSON.stringify(input), JSON.stringify(callback), priority],
  );
  return mapRow(rows[0]);
}

export async function getJob(pool: PgPool, jobId: string): Promise<Job | null> {
  const { rows } = await pool.query(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
  return rows.length ? mapRow(rows[0]) : null;
}

export async function listJobs(
  pool: PgPool,
  tenantId: string,
  opts: { limit?: number; offset?: number; status?: JobStatus; domain?: string } = {},
): Promise<Job[]> {
  const conditions = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  let idx = 2;

  if (opts.status) {
    conditions.push(`status = $${idx++}`);
    params.push(opts.status);
  }
  if (opts.domain) {
    conditions.push(`domain = $${idx++}`);
    params.push(opts.domain);
  }

  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  params.push(limit, offset);

  const { rows } = await pool.query(
    `SELECT * FROM jobs WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );
  return rows.map(mapRow);
}

export async function updateJob(
  pool: PgPool,
  jobId: string,
  fields: Partial<Pick<Job, 'status' | 'progress' | 'result' | 'error' | 'pendingInput' | 'costUsd' | 'attempts' | 'startedAt' | 'completedAt'>>,
): Promise<Job | null> {
  const sets: string[] = ['updated_at = now()'];
  const params: unknown[] = [];
  let idx = 1;

  if (fields.status !== undefined) {
    sets.push(`status = $${idx++}`);
    params.push(fields.status);
  }
  if (fields.progress !== undefined) {
    sets.push(`progress = $${idx++}`);
    params.push(JSON.stringify(fields.progress));
  }
  if (fields.result !== undefined) {
    sets.push(`result = $${idx++}`);
    params.push(JSON.stringify(fields.result));
  }
  if (fields.error !== undefined) {
    sets.push(`error = $${idx++}`);
    params.push(JSON.stringify(fields.error));
  }
  if (fields.pendingInput !== undefined) {
    sets.push(`pending_input = $${idx++}`);
    params.push(JSON.stringify(fields.pendingInput));
  }
  if (fields.costUsd !== undefined) {
    sets.push(`cost_usd = $${idx++}`);
    params.push(fields.costUsd);
  }
  if (fields.attempts !== undefined) {
    sets.push(`attempts = $${idx++}`);
    params.push(fields.attempts);
  }
  if (fields.startedAt !== undefined) {
    sets.push(`started_at = $${idx++}`);
    params.push(fields.startedAt);
  }
  if (fields.completedAt !== undefined) {
    sets.push(`completed_at = $${idx++}`);
    params.push(fields.completedAt);
  }

  params.push(jobId);
  const { rows } = await pool.query(
    `UPDATE jobs SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    params,
  );
  return rows.length ? mapRow(rows[0]) : null;
}

export async function countActive(pool: PgPool, tenantId: string, domain: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM jobs
     WHERE tenant_id = $1 AND domain = $2 AND status IN ('queued', 'running', 'waiting')`,
    [tenantId, domain],
  );
  return rows[0].count;
}

export async function countToday(pool: PgPool, tenantId: string, domain: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS count FROM jobs
     WHERE tenant_id = $1 AND domain = $2 AND created_at >= CURRENT_DATE`,
    [tenantId, domain],
  );
  return rows[0].count;
}

export interface FindByCallbackOpts {
  type: string;
  channel: string;
  threadTs: string;
  status: JobStatus;
}

export async function findByCallback(pool: PgPool, opts: FindByCallbackOpts): Promise<Job | null> {
  const { rows } = await pool.query(
    `SELECT * FROM jobs
     WHERE status = $1
       AND callback->>'type' = $2
       AND callback->>'channel' = $3
       AND callback->>'threadTs' = $4
     ORDER BY created_at DESC LIMIT 1`,
    [opts.status, opts.type, opts.channel, opts.threadTs],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

// ─── Job Events ─────────────────────────────────────────────────────────────

export async function insertJobEvent(
  pool: PgPool,
  jobId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<JobEvent> {
  const { rows } = await pool.query(
    `INSERT INTO job_events (job_id, event_type, payload)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [jobId, eventType, JSON.stringify(payload)],
  );
  return mapEventRow(rows[0]);
}

export async function getJobEventsSince(
  pool: PgPool,
  jobId: string,
  afterId: number = 0,
): Promise<JobEvent[]> {
  const { rows } = await pool.query(
    `SELECT * FROM job_events
     WHERE job_id = $1 AND id > $2
     ORDER BY id ASC`,
    [jobId, afterId],
  );
  return rows.map(mapEventRow);
}

// ─── Tenant ─────────────────────────────────────────────────────────────────

export interface Tenant {
  id: string;
  name: string;
  apiKey: string;
  slackTeamId: string | null;
  config: Record<string, unknown>;
  quota: { maxConcurrentJobs?: number; maxDailyJobs?: number };
  createdAt: Date;
}

export async function findTenantByApiKey(pool: PgPool, apiKey: string): Promise<Tenant | null> {
  const { rows } = await pool.query(
    `SELECT * FROM tenants WHERE api_key = $1`,
    [apiKey],
  );
  return rows.length ? mapTenantRow(rows[0]) : null;
}

export async function findTenantBySlackTeam(pool: PgPool, teamId: string): Promise<Tenant | null> {
  const { rows } = await pool.query(
    `SELECT * FROM tenants WHERE slack_team_id = $1`,
    [teamId],
  );
  return rows.length ? mapTenantRow(rows[0]) : null;
}

export async function findTenantById(pool: PgPool, id: string): Promise<Tenant | null> {
  const { rows } = await pool.query(
    `SELECT * FROM tenants WHERE id = $1`,
    [id],
  );
  return rows.length ? mapTenantRow(rows[0]) : null;
}

// ─── Approval Events CRUD ───────────────────────────────────────────────────

export interface InsertApprovalEventParams {
  jobId: string;
  actionKey: string;
  actionType: string;
  decision: string;
  decidedBy: string;
  decidedAt: string;
  policyVersion: string;
  rationale?: string;
  evidence: Record<string, unknown>;
}

export async function insertApprovalEvent(pool: PgPool, params: InsertApprovalEventParams): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    `INSERT INTO approval_events (job_id, action_key, action_type, decision, decided_by, decided_at, policy_version, rationale, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      params.jobId, params.actionKey, params.actionType, params.decision,
      params.decidedBy, params.decidedAt, params.policyVersion,
      params.rationale ?? null, JSON.stringify(params.evidence),
    ],
  );
  return rows[0] as Record<string, unknown>;
}

export async function listApprovalEvents(
  pool: PgPool,
  opts: { jobId?: string; limit?: number; offset?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (opts.jobId) {
    conditions.push(`job_id = $${idx++}`);
    params.push(opts.jobId);
  }

  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  params.push(limit, offset);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT * FROM approval_events ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );
  return rows as Array<Record<string, unknown>>;
}

// ─── Playbook Executions CRUD ───────────────────────────────────────────────

export interface InsertPlaybookExecutionParams {
  jobId: string;
  playbookId: string;
  status: string;
  steps: unknown[];
  totalAffectedEntities: number;
}

export async function insertPlaybookExecution(pool: PgPool, params: InsertPlaybookExecutionParams): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    `INSERT INTO playbook_executions (job_id, playbook_id, status, steps, total_affected_entities)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [params.jobId, params.playbookId, params.status, JSON.stringify(params.steps), params.totalAffectedEntities],
  );
  return rows[0] as Record<string, unknown>;
}

export async function getPlaybookExecutions(pool: PgPool, jobId: string): Promise<Array<Record<string, unknown>>> {
  const { rows } = await pool.query(
    `SELECT * FROM playbook_executions WHERE job_id = $1 ORDER BY created_at DESC`,
    [jobId],
  );
  return rows as Array<Record<string, unknown>>;
}

// ─── Signal Correlation Queries ─────────────────────────────────────────────

/**
 * Find active SOC jobs for a tenant matching specific signal metadata.
 * Used for correlation (to merge repeated signals into existing analysis jobs).
 */
export async function findActiveSocJobBySignal(
  pool: PgPool,
  tenantId: string,
  signalId: string,
): Promise<Job | null> {
  const { rows } = await pool.query(
    `SELECT * FROM jobs
     WHERE tenant_id = $1
       AND domain = 'soc'
       AND status IN ('queued', 'running', 'action_pending', 'action_executing')
       AND input->'metadata'->>'signalId' = $2
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, signalId],
  );
  return rows.length ? mapRow(rows[0]) : null;
}

// ─── Row mappers ────────────────────────────────────────────────────────────

function mapRow(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    domain: row.domain as Job['domain'],
    status: row.status as Job['status'],
    priority: row.priority as number,
    input: row.input as Job['input'],
    callback: row.callback as Job['callback'],
    progress: row.progress as Job['progress'],
    result: row.result as Job['result'],
    error: row.error as Job['error'],
    pendingInput: row.pending_input as Job['pendingInput'],
    costUsd: row.cost_usd as number | null,
    attempts: row.attempts as number,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
    startedAt: row.started_at ? new Date(row.started_at as string) : null,
    completedAt: row.completed_at ? new Date(row.completed_at as string) : null,
  };
}

function mapEventRow(row: Record<string, unknown>): JobEvent {
  return {
    id: row.id as number,
    jobId: row.job_id as string,
    eventType: row.event_type as string,
    payload: row.payload as Record<string, unknown>,
    createdAt: new Date(row.created_at as string),
  };
}

function mapTenantRow(row: Record<string, unknown>): Tenant {
  return {
    id: row.id as string,
    name: row.name as string,
    apiKey: row.api_key as string,
    slackTeamId: row.slack_team_id as string | null,
    config: row.config as Record<string, unknown>,
    quota: row.quota as Tenant['quota'],
    createdAt: new Date(row.created_at as string),
  };
}
