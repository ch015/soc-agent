import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerRoutes } from '../router.js';
import { enqueue, type RedisConnection } from '../job/queue.js';
import { admitSocJob } from '../job/admission.js';
import type { CanonicalRequest } from '../job/types.js';

vi.mock('../job/queue.js', () => ({ enqueue: vi.fn(async (_domain, job) => job.id) }));
const databaseUrl = process.env.SOC_TEST_DATABASE_URL;
const schema = `soc_admission_${randomUUID().replaceAll('-', '')}`;
const admin = databaseUrl ? new pg.Pool({ connectionString: databaseUrl }) : undefined;
const pools = databaseUrl ? [0, 1].map(() => new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}`, max: 8 })) : [];
const apps = pools.map(pool => { const app = new Hono(); registerRoutes(app, pool, {} as RedisConnection); return app; });
let tenants: Array<{ id: string; api_key: string }> = [];
const signal = (id = 'same-signal', tenant = 0) => ({ signalId: id, signalType: 'alert', source: 'test', severity: 'low',
  timestamp: '2026-09-22T00:00:00Z', subject: { type: 'host', value: 'server' }, tenantId: tenants[tenant]!.id });
const generic = (key?: unknown): CanonicalRequest => ({ domain: 'soc', source: { type: 'snapshot' }, instruction: 'Test',
  callback: { type: 'poll' }, ...(key !== undefined ? { options: { dedupKey: key } } : {}) });
async function request(path: string, body: unknown, instance = 0, tenant = 0) {
  const response = await apps[instance]!.request(path, { method: 'POST', headers: {
    Authorization: `Bearer ${tenants[tenant]!.api_key}`, 'Content-Type': 'application/json',
  }, body: JSON.stringify(body) });
  return { status: response.status, retryAfter: response.headers.get('Retry-After'), body: await response.json() as Record<string, unknown> };
}
const ingress = (body = signal(), instance = 0, tenant = 0) => request('/api/v1/hooks/soc/signal', body, instance, tenant);
const submit = (key?: unknown, instance = 0) => request('/api/v1/jobs', generic(key), instance);
async function quota(value: Record<string, number>) {
  await pools[0]!.query('UPDATE tenants SET quota = $1 WHERE id = $2', [JSON.stringify(value), tenants[0]!.id]);
}
async function countJobs() { return Number((await pools[0]!.query('SELECT count(*) FROM jobs')).rows[0].count); }

describe.skipIf(!databaseUrl)('atomic SOC admission with real PostgreSQL', () => {
  beforeAll(async () => {
    await admin!.query(`CREATE SCHEMA ${schema}`);
    for (const name of ['001-initial.sql', '002-soc.sql', '003-workflow-deliveries.sql']) {
      await pools[0]!.query(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    }
  });
  beforeEach(async () => {
    vi.clearAllMocks(); vi.mocked(enqueue).mockReset().mockImplementation(async (_domain, job) => job.id);
    await pools[0]!.query('TRUNCATE tenants CASCADE');
    tenants = (await pools[0]!.query("INSERT INTO tenants(name, api_key, quota) VALUES ('a','fixture-a','{\"maxConcurrentJobs\":100,\"maxDailyJobs\":1000}'), ('b','fixture-b','{\"maxConcurrentJobs\":100,\"maxDailyJobs\":1000}') RETURNING id, api_key")).rows;
  });
  afterAll(async () => {
    await Promise.all(pools.map(pool => pool.end()));
    try { await admin!.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin!.end(); }
  });

  it.each([{ maxConcurrentJobs: 0, maxDailyJobs: 100 }, { maxConcurrentJobs: 100, maxDailyJobs: 0 }])('rejects zero quota %j before creating or enqueuing a job', async limits => {
    await quota(limits);
    expect((await ingress()).status).toBe(429); expect(await countJobs()).toBe(0); expect(enqueue).not.toHaveBeenCalled();
  });
  it('creates one job for 16 identical signals across two independent gateway pools', async () => {
    const replies = await Promise.all(Array.from({ length: 16 }, (_, i) => ingress(signal(), i % 2)));
    expect(replies.filter(r => r.status === 202)).toHaveLength(1);
    expect(replies.filter(r => r.body.duplicate === true)).toHaveLength(15);
    expect(new Set(replies.map(r => r.body.jobId)).size).toBe(1); expect(await countJobs()).toBe(1);
  });
  it('applies the shared concurrent quota across both HTTP entry points', async () => {
    await quota({ maxConcurrentJobs: 3, maxDailyJobs: 100 });
    const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2 ? submit(`key-${i}`, 1) : ingress(signal(`signal-${i}`))));
    expect(replies.filter(r => r.status === 201 || r.status === 202)).toHaveLength(3);
    expect(replies.filter(r => r.status === 429)).toHaveLength(9); expect(await countJobs()).toBe(3);
  });
  it('applies daily quota even when earlier jobs have completed', async () => {
    await submit('finished'); await pools[0]!.query("UPDATE jobs SET status='completed'");
    await quota({ maxConcurrentJobs: 100, maxDailyJobs: 2 });
    const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => ingress(signal(`daily-${i}`), i % 2)));
    expect(replies.filter(r => r.status === 202)).toHaveLength(1);
    expect(replies.filter(r => r.status === 429)).toHaveLength(7); expect(await countJobs()).toBe(2);
  });
  it.each(['action_pending', 'action_executing'])('counts %s against concurrent quota', async status => {
    await submit('active'); await pools[0]!.query('UPDATE jobs SET status=$1', [status]);
    await quota({ maxConcurrentJobs: 1, maxDailyJobs: 100 });
    expect((await ingress()).status).toBe(429);
  });
  it('deduplicates options.dedupKey concurrently before quota checks', async () => {
    await quota({ maxConcurrentJobs: 1, maxDailyJobs: 1 });
    const replies = await Promise.all(Array.from({ length: 16 }, (_, i) => submit('generic-key', i % 2)));
    expect(replies.filter(r => r.status === 201)).toHaveLength(1);
    expect(replies.filter(r => r.status === 200 && r.body.duplicate === true)).toHaveLength(15);
    expect(new Set(replies.map(r => r.body.jobId ?? r.body.id)).size).toBe(1); expect(await countJobs()).toBe(1);
    expect((await submit('different-key')).status).toBe(429);
  });
  it.each([null, 0, {}, '', ' ', 'x'.repeat(513)])('rejects malformed dedupKey %j', async key => {
    expect((await submit(key)).status).toBe(400); expect(await countJobs()).toBe(0);
  });
  it('isolates identical signal IDs and generic keys across tenants', async () => {
    const replies = await Promise.all([ingress(signal()), ingress(signal('same-signal', 1), 1, 1),
      submit('same-key'), request('/api/v1/jobs', generic('same-key'), 1, 1)]);
    expect(replies.map(r => r.status)).toEqual([202, 202, 201, 201]); expect(await countJobs()).toBe(4);
  });
  it('correlates concurrent signals by subject and rule using durable job data', async () => {
    const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => ingress({ ...signal(`related-${i}`),
      rule: { id: 'rule-1', name: 'Rule', category: 'test' } } as ReturnType<typeof signal>, i % 2)));
    expect(replies.filter(r => r.status === 202)).toHaveLength(1);
    expect(replies.filter(r => r.body.correlated === true)).toHaveLength(7); expect(await countJobs()).toBe(1);
  });
  it('keeps a signal retry idempotent after quota fills and queue delivery fails', async () => {
    await quota({ maxConcurrentJobs: 1, maxDailyJobs: 1 });
    vi.mocked(enqueue).mockRejectedValueOnce(new Error('Redis unavailable'));
    const first = await ingress(); expect(first.status).toBe(503); expect(first.body.retryable).toBe(true);
    await pools[0]!.query("UPDATE jobs SET created_at=now()-interval '10 minutes'");
    const retried = await ingress(signal(), 1);
    expect(retried.status).toBe(200); expect(retried.body.jobId).toBe(first.body.jobId);
    expect(vi.mocked(enqueue).mock.calls.map(call => call[1].id)).toEqual([first.body.jobId, first.body.jobId]);
    expect(await countJobs()).toBe(1);
  });
  it('does not correlate a new signal to an old queued job after the window expires', async () => {
    const rule = { id: 'rule', name: 'Rule', category: 'test' };
    await ingress({ ...signal('old'), rule } as ReturnType<typeof signal>);
    await pools[0]!.query("UPDATE jobs SET created_at=now()-interval '10 minutes'");
    const next = await ingress({ ...signal('new'), rule } as ReturnType<typeof signal>, 1);
    expect(next.status).toBe(202); expect(await countJobs()).toBe(2);
  });
  it('recovers a queued generic admission without creating or charging another job', async () => {
    vi.mocked(enqueue).mockRejectedValueOnce(new Error('Redis unavailable'));
    const first = await submit('delivery-retry'); expect(first.status).toBe(503);
    expect(first.body.retryable).toBe(true); expect(first.retryAfter).toBe('5');
    await pools[0]!.query("UPDATE jobs SET created_at=now()-interval '10 minutes'");
    await quota({ maxConcurrentJobs: 0, maxDailyJobs: 0 });
    const retried = await submit('delivery-retry', 1);
    expect(retried.status).toBe(200); expect(retried.body.jobId).toBe(first.body.jobId); expect(await countJobs()).toBe(1);
  });
  it('does not encourage unsafe POST retries when a generic request has no dedup key', async () => {
    vi.mocked(enqueue).mockRejectedValueOnce(new Error('Redis unavailable'));
    const first = await submit();
    expect(first.status).toBe(503); expect(first.body.retryable).toBe(false); expect(first.retryAfter).toBeNull();
    expect(first.body.jobId).toEqual(expect.any(String)); expect(await countJobs()).toBe(1);
  });
  it('lets the normal window expire for completed signals and running generic requests', async () => {
    await ingress(); await submit('expired');
    await pools[0]!.query("UPDATE jobs SET created_at=now()-interval '10 minutes', status=CASE WHEN input->'metadata'->>'signalId' IS NULL THEN 'running' ELSE 'completed' END");
    expect((await ingress()).status).toBe(202); expect((await submit('expired')).status).toBe(201);
    expect(await countJobs()).toBe(4);
  });
  it('rolls back failed creation and releases the tenant lock for the next request', async () => {
    await expect(admitSocJob(pools[0]!, { tenantId: tenants[0]!.id, request: generic('invalid'), priority: 1.5 })).rejects.toThrow();
    expect(await countJobs()).toBe(0);
    expect((await submit('valid', 1)).status).toBe(201); expect(await countJobs()).toBe(1);
  });
});
