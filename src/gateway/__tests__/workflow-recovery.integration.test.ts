import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { Hono } from 'hono';
import pg from 'pg';
import Redis from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerRoutes } from '../router.js';
import { loadConfig } from '../config.js';
import { createJob, getJob } from '../job/store.js';
import { transitionJob } from '../job/lifecycle.js';
import { enqueue, closeAllQueues, getOrCreateQueue } from '../job/queue.js';
import { dispatchOutbox, reconcileQueueFailures } from '../job/outbox.js';
import { createDomainWorker, type DomainHandler } from '../workers/runner.js';
import { resultRouter } from '../result/router.js';
import type { Job, CanonicalRequest, DomainType } from '../job/types.js';

const domain: DomainType = 'soc';
const url = process.env.WORKFLOW_TEST_DATABASE_URL;
const redisUrl = process.env.WORKFLOW_TEST_REDIS_URL;
const schema = 'workflow_' + randomUUID().replaceAll('-', '');
const admin = url ? new pg.Pool({ connectionString: url }) : undefined;
const pool = url ? new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, query_timeout: 5000 }) : undefined;
const redis = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: null }) : undefined;
const queue = redis ? getOrCreateQueue(domain, redis) : undefined;
const workers: ReturnType<typeof createDomainWorker>[] = [], children: ChildProcess[] = [];
let tenantId: string;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => Promise<unknown>, ms = 5000) { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return; await sleep(20); } throw new Error('Timed out waiting for expected state'); }
const request: CanonicalRequest = { domain, source: { type: 'snapshot' }, instruction: 'Review test', callback: { type: 'poll' } };
async function make(callback: Job['callback'] = { type: 'poll' }) { return createJob(pool!, { tenantId, domain, input: request, callback }); }
function start(handler: Omit<DomainHandler, 'domain'>, timeoutMs = 5000) { const worker = createDomainWorker({ domain, ...handler }, redis!, pool!, { concurrency: 1, timeoutMs, lockDuration: 1000 }); workers.push(worker); return worker; }
async function kill(child: ChildProcess) { if (child.exitCode !== null || child.signalCode !== null) return; const done = once(child, 'exit'); child.kill('SIGKILL'); await done; }

describe.skipIf(!url || !redisUrl)('durable workflow delivery and execution with real PostgreSQL/Redis', () => {
  beforeAll(async () => {
    await admin!.query(`CREATE SCHEMA ${schema}`);
    for (const name of ['001-initial.sql', '002-soc.sql', '003-workflow-deliveries.sql']) await pool!.query(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
    loadConfig({ DATABASE_URL: url, ARTIFACT_ACCESS_KEY: 'fixture', ARTIFACT_SECRET_KEY: 'fixture', SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_SIGNING_SECRET: 'fixture' });
  });
  beforeEach(async () => {
    await queue!.obliterate({ force: true }); await pool!.query('TRUNCATE tenants CASCADE');
    tenantId = (await pool!.query("INSERT INTO tenants(name,api_key) VALUES('test','workflow-test') RETURNING id")).rows[0].id;
  });
  afterEach(async () => { for (const child of children.splice(0)) await kill(child); for (const worker of workers.splice(0)) await worker.close(true); });
  afterAll(async () => { await closeAllQueues(); redis?.disconnect(); await pool?.end(); try { await admin?.query(`DROP SCHEMA ${schema} CASCADE`); } finally { await admin?.end(); } });

  it('rejects a stale state transition after cancellation', async () => {
    const job = await make(); await transitionJob(pool!, job, 'cancelled');
    await expect(transitionJob(pool!, job, 'running')).rejects.toThrow('state changed');
    expect((await getJob(pool!, job.id))!.status).toBe('cancelled');
  });
  it('persists an approval and a distinct delivery before Redis dispatch', async () => {
    let job = await transitionJob(pool!, await make(), 'running');
    job = await transitionJob(pool!, job, 'action_pending');
    const app = new Hono(); registerRoutes(app, pool!, redis!);
    const response = await app.request('/api/v1/jobs/'+job.id+'/approve', { method: 'POST',
      headers: { Authorization: 'Bearer workflow-test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', rationale: 'fixture approval' }) });
    expect(response.status).toBe(200);
    const accepted = (await getJob(pool!, job.id))!;
    expect(accepted.pendingInput).toEqual({ decision: 'approve', rationale: 'fixture approval' });
    expect(accepted.deliveryId).toContain('-approval-');
    expect(await queue!.getJob(accepted.deliveryId!)).toBeUndefined();
    let resumed = 0;
    start({ async process() { throw new Error('Must resume approval'); }, async resume(current, answer, db) {
      expect(answer).toEqual(accepted.pendingInput); resumed++; await transitionJob(db, current, 'completed');
    } });
    await dispatchOutbox(pool!, redis!);
    await until(async () => (await getJob(pool!, job.id))!.status === 'completed');
    expect(resumed).toBe(1);
  });
  it('commits state, event and notification together or rolls back all three', async () => {
    const job = await transitionJob(pool!, await make({ type: 'webhook', url: 'http://fixture.invalid' }), 'running');
    await pool!.query("CREATE FUNCTION reject_callback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='callback' THEN RAISE EXCEPTION 'injected outbox error'; END IF; RETURN NEW; END $$");
    await pool!.query('CREATE TRIGGER test_reject BEFORE INSERT ON gateway_outbox FOR EACH ROW EXECUTE FUNCTION reject_callback()');
    try {
      await expect(transitionJob(pool!, job, 'completed', { notification: { type: 'completed' } })).rejects.toThrow('injected outbox error');
      expect((await getJob(pool!, job.id))!.status).toBe('running');
      expect((await pool!.query("SELECT count(*)::int AS n FROM job_events WHERE job_id=$1 AND event_type='completed'",[job.id])).rows[0].n).toBe(0);
    } finally { await pool!.query('DROP TRIGGER test_reject ON gateway_outbox'); await pool!.query('DROP FUNCTION reject_callback()'); }
  });
  it('delivers a DB-only initial admission after the dispatcher restarts', async () => {
    const job = await make(); expect(await queue!.getJob(job.id)).toBeUndefined();
    start({ async process(current, db) { await transitionJob(db, current, 'completed'); } });
    await dispatchOutbox(pool!, redis!);
    await until(async () => (await getJob(pool!, job.id))!.status === 'completed');
    expect((await pool!.query('SELECT delivered_at FROM gateway_outbox WHERE id=$1',['execution:'+job.id])).rows[0].delivered_at).not.toBeNull();
  });
  it('retries a failed callback independently after the analysis is completed', async () => {
    let calls = 0;
    resultRouter.register('webhook', { type: 'webhook', async handle() { if (++calls === 1) throw new Error('temporary callback outage'); } });
    const job = await make({ type: 'webhook', url: 'http://fixture.invalid' });
    start({ async process(current, db) { await transitionJob(db, current, 'completed', { notification: { type: 'completed', summary: 'retained' } }); } });
    await enqueue(domain, job, redis!); await until(async () => (await getJob(pool!, job.id))!.status === 'completed');
    await dispatchOutbox(pool!, redis!); expect(calls).toBe(1);
    expect((await getJob(pool!, job.id))!.status).toBe('completed');
    await pool!.query("UPDATE gateway_outbox SET available_at=now() WHERE kind='callback'");
    await dispatchOutbox(pool!, redis!); expect(calls).toBe(2);
    expect((await pool!.query("SELECT delivered_at FROM gateway_outbox WHERE kind='callback'")).rows[0].delivered_at).not.toBeNull();
  });
  it('keeps clarification notification retryable while the job is waiting', async () => {
    let calls = 0; resultRouter.register('webhook', { type: 'webhook', async handle() { if (++calls === 1) throw new Error('outage'); } });
    const job = await make({ type: 'webhook', url: 'http://fixture.invalid' });
    start({ async process(current, db) { await transitionJob(db, current, 'waiting', { pendingInput: { questions: ['Owner?'] }, notification: { type: 'clarification', questions: ['Owner?'] } }); } });
    await enqueue(domain, job, redis!); await until(async () => (await getJob(pool!, job.id))!.status === 'waiting');
    await dispatchOutbox(pool!, redis!); await pool!.query("UPDATE gateway_outbox SET available_at=now() WHERE kind='callback'"); await dispatchOutbox(pool!, redis!);
    expect(calls).toBe(2); expect((await getJob(pool!, job.id))!.status).toBe('waiting');
  });
  it('enforces the execution deadline and fences a late handler completion', async () => {
    let release!: () => void; let lateError: unknown;
    const job = await make();
    start({ async process(current, db) {
      await new Promise<void>(resolve => { release = resolve; });
      try { const latest = (await getJob(db, current.id))!; await transitionJob(db, latest, 'completed'); }
      catch (error) { lateError = error; }
    } }, 150);
    await enqueue(domain, job, redis!, { attempts: 1 }); await until(async () => (await getJob(pool!, job.id))!.status === 'failed');
    release(); await until(async () => !!lateError);
    expect(String(lateError)).toContain('deadline'); expect((await getJob(pool!, job.id))!.status).toBe('failed');
    expect((await getJob(pool!, job.id))!.executionToken).toBeNull();
  });
  it('propagates cancellation to the active handler and preserves cancelled status', async () => {
    let entered = false, aborted = false; const job = await make();
    start({ async process(_job, _db, execution) { entered = true; await new Promise<void>(resolve => execution!.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); } });
    await enqueue(domain, job, redis!); await until(async () => entered);
    await transitionJob(pool!, (await getJob(pool!, job.id))!, 'cancelled');
    await until(async () => aborted, 3000); expect((await getJob(pool!, job.id))!.status).toBe('cancelled');
  });
  it('reconciles stalled exhaustion after two real worker process deaths', async () => {
    const job = await make(); await enqueue(domain, job, redis!, { attempts: 1 });
    async function launch(marker: string) {
      const endpoint = new URL(url!); endpoint.searchParams.set('options', `-c search_path=${schema}`);
      const child = spawn(process.execPath, ['--import','tsx',new URL('./fixtures/crash-worker.ts', import.meta.url).pathname], { cwd: new URL('../../../', import.meta.url).pathname,
        env: { ...process.env, WORKFLOW_CHILD_DATABASE_URL: endpoint.toString(), WORKFLOW_TEST_REDIS_URL: redisUrl }, stdio: ['ignore','pipe','pipe'] });
      children.push(child); let output = ''; child.stdout!.on('data', bytes => { output += bytes; }); child.stderr!.on('data', bytes => { output += bytes; });
      await until(async () => { if (child.exitCode !== null) throw new Error(output); return output.includes(marker); }, 8000); return child;
    }
    await kill(await launch('HANDLER_STARTED')); await sleep(300);
    await kill(await launch('HANDLER_STARTED')); await sleep(300);
    const recovery = await launch('QUEUE_FAILED'); await kill(recovery);
    // Polling must also repair the state if the event listener died before its DB commit.
    await reconcileQueueFailures(pool!, redis!, domain);
    expect(await (await queue!.getJob(job.id))!.getState()).toBe('failed');
    expect((await getJob(pool!, job.id))!.status).toBe('failed');
  }, 20_000);

});
