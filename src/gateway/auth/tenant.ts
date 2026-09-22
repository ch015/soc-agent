/** Tenant authentication middleware and helpers. */
import type { Context, Next } from 'hono';

import type { PgPool, PgQuery, Tenant } from '../job/store.js';
import { findTenantByApiKey, findTenantBySlackTeam, countActive, countToday } from '../job/store.js';

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Hono middleware: authenticate by Bearer API key.
 * Sets c.set('tenant') and c.set('tenantId').
 */
export function bearerAuth(pool: PgPool) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Missing or invalid Authorization header' }, 401);
    }

    const apiKey = authHeader.slice(7);
    const tenant = await findTenantByApiKey(pool, apiKey);
    if (!tenant) {
      return c.json({ error: 'Invalid API key' }, 401);
    }

    (c as unknown as { set(key: string, value: unknown): void }).set('tenant', tenant);
    (c as unknown as { set(key: string, value: unknown): void }).set('tenantId', tenant.id);
    await next();
  };
}

/**
 * Resolve tenant from Slack team_id (used by Slack event handlers
 * after signature verification).
 */
export async function resolveTenantBySlackTeam(
  pool: PgPool,
  teamId: string,
): Promise<Tenant> {
  const tenant = await findTenantBySlackTeam(pool, teamId);
  if (!tenant) {
    throw new AuthError(`Unknown Slack workspace: ${teamId}`);
  }
  return tenant;
}

/**
 * Check tenant quota (concurrent + daily limits).
 */
export class QuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuotaError';
  }
}

export async function checkQuota(
  pool: PgQuery,
  tenant: Tenant,
  domain: string,
): Promise<void> {
  const active = await countActive(pool, tenant.id, domain);
  const limit = tenant.quota.maxConcurrentJobs ?? 5;

  if (active >= limit) {
    throw new QuotaError(`Concurrent job limit exceeded: ${active}/${limit}`);
  }

  const today = await countToday(pool, tenant.id, domain);
  const dailyLimit = tenant.quota.maxDailyJobs ?? 100;

  if (today >= dailyLimit) {
    throw new QuotaError(`Daily job limit exceeded: ${today}/${dailyLimit}`);
  }
}
