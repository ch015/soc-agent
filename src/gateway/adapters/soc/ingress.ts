/** SOC Event Ingress handler — validates signal, authenticates, emits to gateway. */
import type { Context } from 'hono';
import { readJson } from '../../request-validation.js';

import type { PgPool } from '../../job/store.js';
import { admitSocJob, deliverAdmission, QueueDeliveryError } from '../../job/admission.js';
import { QuotaError } from '../../auth/tenant.js';
import type { RedisConnection } from '../../job/queue.js';
import { SocSignalSchema, SEVERITY_PRIORITY_MAP } from './types.js';
import type { SocSignal } from './types.js';
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
    const body = await readJson(c);
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

    // 3. Determine priority
    const priority = SEVERITY_PRIORITY_MAP[signal.severity];

    // 4. Build the request for atomic quota checking and job creation
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

    try {
      const admission = await admitSocJob(pool, { tenantId: tenant.id, request: canonicalRequest, signal, priority });
      await deliverAdmission(admission, redis);
      if (admission.kind !== 'created') {
        return c.json({ ok: true, [admission.kind]: true, jobId: admission.job.id, signalId: signal.signalId });
      }
      return c.json({ ok: true, jobId: admission.job.id, status: admission.job.status, priority }, 202);
    } catch (error) {
      if (error instanceof QuotaError) return c.json({ error: error.message }, 429);
      if (error instanceof QueueDeliveryError) {
        c.header('Retry-After', '5');
        return c.json({ error: error.message, jobId: error.jobId, retryable: true }, 503);
      }
      throw error;
    }
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
