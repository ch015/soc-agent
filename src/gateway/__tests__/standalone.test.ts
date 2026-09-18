import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { CanonicalRequestSchema } from '../job/types.js';
import { QUEUE_CONFIGS } from '../job/queue-config.js';
import { registerRoutes } from '../router.js';
import type { PgPool } from '../job/store.js';
import type { RedisConnection } from '../job/queue.js';

describe('SOC service boundary', () => {
  it('starts configuration without unrelated artifact or Slack credentials', () => {
    expect(loadConfig({ DATABASE_URL: 'postgresql://soc:local@localhost/soc', JIRA_BASE_URL: '' }).SLACK_BOT_TOKEN).toBe('');
    expect(Object.keys(QUEUE_CONFIGS)).toEqual(['soc']);
  });

  it('accepts SOC options with the installed Zod version and rejects other domains', () => {
    const request = { domain: 'soc', source: { type: 'snapshot' }, instruction: 'Analyze signal', options: { missionType: 'report' }, callback: { type: 'poll' }, metadata: { signalId: 'signal-1' } };
    expect(CanonicalRequestSchema.parse(request)).toEqual(request);
    for (const domain of ['feedback', 'offsec']) expect(CanonicalRequestSchema.safeParse({ ...request, domain }).success).toBe(false);
  });

  it('exposes health and SOC endpoints without the old ingress routes', async () => {
    const app = new Hono();
    registerRoutes(app, {} as PgPool, {} as RedisConnection);
    expect((await app.request('/api/v1/health')).status).toBe(200);
    expect((await app.request('/api/v1/hooks/soc/signal', { method: 'POST' })).status).toBe(401);
    for (const route of ['/api/v1/hooks/offsec/github', '/api/v1/hooks/slack/events']) {
      expect((await app.request(route, { method: 'POST' })).status).toBe(404);
    }
  });
});
