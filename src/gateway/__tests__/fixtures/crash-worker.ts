import Redis from 'ioredis';
import { createPool } from '../../job/store.js';
import { createDomainWorker } from '../../workers/runner.js';
const pool = createPool(process.env.WORKFLOW_CHILD_DATABASE_URL!);
const redis = new Redis(process.env.WORKFLOW_TEST_REDIS_URL!, { maxRetriesPerRequest: null });
const worker = createDomainWorker({ domain: 'soc', async process() { console.log('HANDLER_STARTED'); await new Promise(() => {}); } }, redis, pool, { concurrency: 1, lockDuration: 200, timeoutMs: 30_000 });
worker.opts.stalledInterval = 100;
worker.on('failed', () => console.log('QUEUE_FAILED'));
await worker.waitUntilReady();
