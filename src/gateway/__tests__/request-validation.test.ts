import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { loadConfig } from '../config.js';
import { registerRoutes } from '../router.js';
import type { PgPool } from '../job/store.js';
import type { RedisConnection } from '../job/queue.js';

it.each<{ path: string; method: string; body?: string }>([
  { path: '/api/v1/jobs', method: 'POST', body: '{' },
  { path: '/api/v1/jobs/not-a-uuid', method: 'GET' },
  { path: '/api/v1/jobs/not-a-uuid/result', method: 'GET' },
  { path: '/api/v1/jobs/not-a-uuid/input', method: 'POST', body: '{}' },
  { path: '/api/v1/jobs/not-a-uuid', method: 'DELETE' },
  { path: '/api/v1/jobs/not-a-uuid/stream', method: 'GET' },
  ...['limit=-1', 'limit=abc', 'limit=1.5', 'limit=10x', 'limit=1001', 'offset=-1'].map(query => ({ path: '/api/v1/jobs?' + query, method: 'GET' })),
])('returns 400 before a database operation for $method $path', async ({ path, method, body }) => {
  loadConfig({ DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture', ARTIFACT_ACCESS_KEY: 'fixture',
    ARTIFACT_SECRET_KEY: 'fixture', SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_SIGNING_SECRET: 'fixture' });
  const query = vi.fn().mockResolvedValue({ rows: [{ id: 'tenant-fixture', name: 'fixture', config: {}, quota: {}, created_at: new Date(0) }] });
  const app = new Hono(); registerRoutes(app, { query } as unknown as PgPool, {} as RedisConnection);
  const result = await app.request(path, { method, body, headers: { Authorization: 'Bearer fixture', 'Content-Type': 'application/json' } });
  expect(result.status).toBe(400); expect(query).toHaveBeenCalledTimes(1);
  expect(await result.json()).toHaveProperty('error');
});
