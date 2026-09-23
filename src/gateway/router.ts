/** Register all routes on the Hono app. */
import { Hono } from 'hono';
import { z } from 'zod';
import { readJson, requestId, pagination } from './request-validation.js';

import type { PgPool } from './job/store.js';
import type { RedisConnection } from './job/queue.js';
import { bearerAuth } from './auth/tenant.js';
import { QuotaError } from './auth/tenant.js';
import { admitSocJob, deliverAdmission, QueueDeliveryError } from './job/admission.js';
import {
  getJob,
  listJobs,
  type Tenant,
} from './job/store.js';
import { listAuditEvents } from './approval/audit.js';
import { transitionJob } from './job/lifecycle.js';
import { handleJobStream } from './stream/sse.js';
import { CanonicalRequestSchema, type CanonicalRequest, type JobStatus } from './job/types.js';
export function registerRoutes(app: Hono, pool: PgPool, redis: RedisConnection): void {

  // ─── Health ─────────────────────────────────────────────────────────────
  app.get('/api/v1/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

  // ─── Job CRUD (authenticated) ──────────────────────────────────────────
  const jobs = new Hono();
  jobs.use('*', bearerAuth(pool));

  // POST /api/v1/jobs — submit a new job
  jobs.post('/', async (c) => {
    const tenant = (c as unknown as { get(key: string): unknown }).get('tenant') as Tenant;
    const raw = await readJson(c);
    const parsed = CanonicalRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Invalid request body', details: parsed.error.issues }, 400);
    }
    const body = parsed.data as CanonicalRequest;

    try {
      const admission = await admitSocJob(pool, { tenantId: tenant.id, request: body,
        priority: (body.options?.priority as number) ?? 3 });
      await deliverAdmission(admission, redis);
      if (admission.kind === 'duplicate') return c.json({ duplicate: true, jobId: admission.job.id });
      return c.json({ id: admission.job.id, status: admission.job.status }, 201);
    } catch (error) {
      if (error instanceof QuotaError) return c.json({ error: error.message }, 429);
      if (error instanceof QueueDeliveryError) {
        // Without a stable key, a repeated POST can create a second job.
        const retryable = typeof body.options?.dedupKey === 'string';
        if (retryable) c.header('Retry-After', '5');
        return c.json({ error: error.message, jobId: error.jobId, retryable }, 503);
      }
      throw error;
    }
  });

  // GET /api/v1/jobs — list jobs for tenant
  jobs.get('/', async (c) => {
    const tenantId = (c as unknown as { get(key: string): unknown }).get('tenantId') as string;
    const status = c.req.query('status') as JobStatus | undefined;
    const domain = c.req.query('domain') as string | undefined;
    const { limit, offset } = pagination(c);
    const list = await listJobs(pool, tenantId, { status, domain, limit, offset });
    return c.json(list);
  });

  // GET /api/v1/jobs/:id — get job status
  jobs.get('/:id', async (c) => {
    const job = await getJob(pool, requestId(c.req.param('id')));
    if (!job) return c.json({ error: 'Not found' }, 404);
    const tenantId = (c as unknown as { get(key: string): unknown }).get('tenantId') as string;
    if (job.tenantId !== tenantId) return c.json({ error: 'Forbidden' }, 403);
    return c.json(job);
  });

  // GET /api/v1/jobs/:id/result — get job result
  jobs.get('/:id/result', async (c) => {
    const job = await getJob(pool, requestId(c.req.param('id')));
    if (!job) return c.json({ error: 'Not found' }, 404);
    const tenantId = (c as unknown as { get(key: string): unknown }).get('tenantId') as string;
    if (job.tenantId !== tenantId) return c.json({ error: 'Forbidden' }, 403);
    if (job.status !== 'completed') {
      return c.json({ error: 'Job not completed', status: job.status }, 409);
    }
    return c.json(job.result);
  });

  // POST /api/v1/jobs/:id/input — submit input for a waiting job
  jobs.post('/:id/input', async (c) => {
    const job = await getJob(pool, requestId(c.req.param('id')));
    if (!job) return c.json({ error: 'Not found' }, 404);
    const tenantId = (c as unknown as { get(key: string): unknown }).get('tenantId') as string;
    if (job.tenantId !== tenantId) return c.json({ error: 'Forbidden' }, 403);
    if (job.status !== 'waiting') {
      return c.json({ error: 'Job is not waiting for input', status: job.status }, 409);
    }

    const input = await readJson(c);
    await transitionJob(pool, job, 'running', { pendingInput: input as Record<string, unknown>,
      deliveryId: `${job.id}-input-${job.version ?? 0}` });
    return c.json({ status: 'running' });
  });

  // DELETE /api/v1/jobs/:id — cancel a job
  jobs.delete('/:id', async (c) => {
    const job = await getJob(pool, requestId(c.req.param('id')));
    if (!job) return c.json({ error: 'Not found' }, 404);
    const tenantId = (c as unknown as { get(key: string): unknown }).get('tenantId') as string;
    if (job.tenantId !== tenantId) return c.json({ error: 'Forbidden' }, 403);

    try {
      await transitionJob(pool, job, 'cancelled');
      return c.json({ status: 'cancelled' });
    } catch {
      return c.json({ error: 'Cannot cancel job in current state', status: job.status }, 409);
    }
  });

  // GET /api/v1/jobs/:id/stream — SSE progress
  jobs.get('/:id/stream', (c) => { requestId(c.req.param('id')); return handleJobStream(pool)(c); });

  app.route('/api/v1/jobs', jobs);

  // ─── SOC Hooks ──────────────────────────────────────────────────────────────

  // POST /api/v1/hooks/soc/signal
  app.post('/api/v1/hooks/soc/signal', async (c) => {
    const { handleSocSignal } = await import('./adapters/soc/ingress.js');
    const handler = handleSocSignal({ pool, redis });
    return handler(c);
  });

  // POST /api/v1/jobs/:id/approve — manual approval for SOC actions
  const approveRoute = new Hono();
  approveRoute.use('*', bearerAuth(pool));
  approveRoute.post('/:id/approve', async (c) => {
    const jobId = requestId(c.req.param('id'));
    const job = await getJob(pool, jobId);
    if (!job) return c.json({ error: 'Not found' }, 404);

    const tenantId = (c as unknown as { get(key: string): unknown }).get('tenantId') as string;
    if (job.tenantId !== tenantId) return c.json({ error: 'Forbidden' }, 403);

    if (job.status !== 'action_pending') {
      return c.json({ error: 'Job is not pending approval', status: job.status }, 409);
    }

    const parsed = z.object({ decision: z.enum(['approve', 'deny']), rationale: z.string().optional() }).safeParse(await readJson(c));
    if (!parsed.success) {
      return c.json({ error: 'Invalid decision. Must be "approve" or "deny".' }, 400);
    }

    const body = parsed.data;

    // Record audit event
    const { appendAuditEvent } = await import('./approval/audit.js');
    const operator = (c as unknown as { get(key: string): unknown }).get('tenant') as Tenant;
    await appendAuditEvent(pool, {
      jobId,
      actionKey: 'manual-approval',
      actionType: 'manual',
      decision: body.decision === 'approve' ? 'manually-approved' : 'denied',
      decidedBy: `operator:${operator.name}`,
      decidedAt: new Date().toISOString(),
      policyVersion: '1.0.0',
      rationale: body.rationale,
      evidence: { signalSeverity: 'unknown', analysisConfidence: 0, matchedPolicyRule: 'manual' },
    });

    if (body.decision === 'deny') {
      await transitionJob(pool, job, 'completed', {
        result: { denied: true, rationale: body.rationale },
        notification: { type: 'completed', summary: 'SOC action denied' },
      });
      return c.json({ status: 'denied' });
    }

    await transitionJob(pool, job, 'action_executing', { pendingInput: body,
      deliveryId: `${job.id}-approval-${job.version ?? 0}` });
    return c.json({ status: 'approved' });
  });
  app.route('/api/v1/jobs', approveRoute);

  // GET /api/v1/playbooks
  const playbookRoutes = new Hono();
  playbookRoutes.use('*', bearerAuth(pool));
  playbookRoutes.get('/', (c) => {
    // Return built-in playbooks
    const playbooks = [
      {
        id: 'pb-observe-notify',
        name: 'Observe & Notify',
        version: '1.0.0',
        category: 'observe',
        trigger: { actionTypes: ['notify-team', 'create-incident', 'increase-monitoring'] },
      },
    ];
    return c.json(playbooks);
  });
  playbookRoutes.get('/:id', (c) => {
    const id = c.req.param('id');
    if (id === 'pb-observe-notify') {
      return c.json({
        id: 'pb-observe-notify',
        name: 'Observe & Notify',
        version: '1.0.0',
        category: 'observe',
        trigger: { actionTypes: ['notify-team', 'create-incident', 'increase-monitoring'] },
        steps: [
          { id: 'step-notify', action: 'notify-team', target: 'soc-alerts', timeout: '30s', continueOnFailure: true },
        ],
        limits: { maxExecutionTime: '5m', maxAffectedEntities: 100, requireConfirmationAbove: 50 },
      });
    }
    return c.json({ error: 'Not found' }, 404);
  });
  app.route('/api/v1/playbooks', playbookRoutes);

  // GET /api/v1/audit/actions
  const auditRoutes = new Hono();
  auditRoutes.use('*', bearerAuth(pool));
  auditRoutes.get('/', async (c) => {
    const tenantId = (c as unknown as { get(key: string): unknown }).get('tenantId') as string;
    const requestedJob = c.req.query('job');
    const jobId = requestedJob === undefined ? undefined : requestId(requestedJob);
    const { limit, offset } = pagination(c);

    const events = await listAuditEvents(pool, { jobId, tenantId, limit, offset });
    return c.json(events);
  });
  app.route('/api/v1/audit/actions', auditRoutes);

  // ─── Tenant Management (authenticated) ──────────────────────────────────
  const tenants = new Hono();
  tenants.use('*', bearerAuth(pool));

  // GET /api/v1/tenants/:id — get tenant info
  tenants.get('/:id', async (c) => {
    const authedTenant = (c as unknown as { get(key: string): unknown }).get('tenant') as Tenant;
    const requestedId = c.req.param('id');
    // Tenants can only view themselves
    if (authedTenant.id !== requestedId) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    return c.json({
      id: authedTenant.id,
      name: authedTenant.name,
      quota: authedTenant.quota,
      config: authedTenant.config,
    });
  });

  app.route('/api/v1/tenants', tenants);
}
