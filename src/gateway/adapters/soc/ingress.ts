/** SOC Event Ingress handler — validates signal, authenticates, emits to gateway. */
import type { Context } from 'hono';

import type { PgPool } from '../../job/store.js';
import { createJob, findTenantById } from '../../job/store.js';
import type { RedisConnection } from '../../job/queue.js';
import { enqueue } from '../../job/queue.js';
import { SocSignalSchema, SEVERITY_PRIORITY_MAP } from './types.js';
import type { SocSignal } from './types.js';
import { SignalCorrelation } from './correlation.js';
import type { CanonicalRequest } from '../../job/types.js';

export interface IngressDeps {
  pool: PgPool;
  redis: RedisConnection;
}

/**
 * Handle incoming SOC signal.
 * POST /api/v1/hooks/soc/signal
 *
 * Authentication: Bearer token (service API key from tenant config).
 */
export function handleSocSignal(deps: IngressDeps) {
  const { pool, redis } = deps;
  const correlation = new SignalCorrelation(redis);

  return async (c: Context) => {
    // 1. Authenticate — API key from Authorization header
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const apiKey = authHeader.slice(7);

    // Look up tenant by API key (reuse existing tenant table)
    const { findTenantByApiKey } = await import('../../job/store.js');
    const tenant = await findTenantByApiKey(pool, apiKey);
    if (!tenant) {
      return c.json({ error: 'Invalid API key' }, 401);
    }

    // 2. Parse and validate signal schema
    const body = await c.req.json();
    const parsed = SocSignalSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: 'Invalid signal schema', details: parsed.error.issues },
        400,
      );
    }

    const signal: SocSignal = parsed.data;

    // Verify tenantId matches authenticated tenant
    if (signal.tenantId !== tenant.id) {
      return c.json({ error: 'Signal tenantId does not match authenticated tenant' }, 403);
    }

    // 3. Deduplication — check by signalId
    const isDuplicate = await correlation.bySignalId(signal.signalId);
    if (isDuplicate) {
      return c.json({ ok: true, duplicate: true, signalId: signal.signalId });
    }

    // 4. Correlation — check for existing job with same subject + rule
    const existingJobId = await correlation.byCorrelation(signal);
    if (existingJobId) {
      return c.json({ ok: true, correlated: true, jobId: existingJobId, signalId: signal.signalId });
    }

    // 5. Determine priority
    const priority = SEVERITY_PRIORITY_MAP[signal.severity];

    // 6. Create canonical request and job
    const canonicalRequest: CanonicalRequest = {
      domain: 'soc',
      source: {
        type: 'snapshot',
        snapshotPath: undefined, // Will be resolved by the worker via LiveSocSourceAdapter
      },
      instruction: buildInstruction(signal),
      options: {
        signal,
        missionType: signal.signalType === 'correlation' ? 'investigation' : 'report',
      },
      callback: {
        type: 'webhook',
        url: undefined, // SOC results route via internal result router
      },
      metadata: {
        signalId: signal.signalId,
        signalType: signal.signalType,
        source: signal.source,
        severity: signal.severity,
      },
    };

    const job = await createJob(pool, {
      tenantId: tenant.id,
      domain: 'soc',
      input: canonicalRequest,
      callback: canonicalRequest.callback,
      priority,
    });

    // 7. Enqueue with priority
    await enqueue('soc', job, redis, { priority });

    // 8. Mark signalId as seen for dedup + set correlation key for subject+rule window
    await correlation.markSeen(signal.signalId, job.id);
    await correlation.setCorrelation(signal, job.id);

    return c.json(
      { ok: true, jobId: job.id, status: job.status, priority },
      202,
    );
  };
}

function buildInstruction(signal: SocSignal): string {
  const parts = [
    `Analyze ${signal.signalType} signal from ${signal.source}.`,
    `Subject: ${signal.subject.type}=${signal.subject.value}.`,
    `Severity: ${signal.severity}.`,
  ];
  if (signal.rule) {
    parts.push(`Rule: ${signal.rule.name} (${signal.rule.id}, category: ${signal.rule.category}).`);
  }
  return parts.join(' ');
}
