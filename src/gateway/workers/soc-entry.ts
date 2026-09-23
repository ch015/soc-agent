/** SOC BullMQ worker entry — priority queue, per-domain config. */
import Redis from 'ioredis';
import { startDeliveryMaintenance } from '../job/outbox.js';

import { loadConfig } from '../config.js';
import { createPool } from '../job/store.js';
import { QUEUE_CONFIGS } from '../job/queue-config.js';
import { createDomainWorker, type DomainHandler } from './runner.js';
import { SocHandler } from './soc-handler.js';
import { SocMonitorHandler } from './soc-monitor-handler.js';
import { initResultRouter, resultRouter } from '../result/router.js';
import { PagerDutyResultHandler, IncidentResultHandler } from '../result/router.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

// Initialize result router with all handlers
initResultRouter(() => config.SLACK_BOT_TOKEN);

// Register SOC-specific result handlers
resultRouter.register('pagerduty', new PagerDutyResultHandler());
resultRouter.register('incident', new IncidentResultHandler());

// Create and start the SOC worker
// v2 monitor handler가 기본, v1은 legacy mission용으로 유지
const useV2 = process.env['SOC_HANDLER_VERSION'] !== 'v1';
const monitor = new SocMonitorHandler();
const legacy = new SocHandler();
const handler: DomainHandler = {
  domain: 'soc',
  process: (job, pool, execution) => (!useV2 || job.input.options?.preparedSnapshot ? legacy : monitor).process(job, pool, execution),
  resume: (job, input, pool, execution) => legacy.resume(job, input, pool, execution),
};
const queueConfig = QUEUE_CONFIGS.soc;
const worker = createDomainWorker(handler, redis, pool, { queueConfig });

console.log(`[soc-worker] Started (${useV2 ? 'v2-monitor' : 'v1-legacy'}). Queue: secops-soc, concurrency: ${queueConfig.concurrency}, timeout: ${queueConfig.timeout}ms`);

const stopMaintenance = startDeliveryMaintenance(pool, redis, 'soc');

// Graceful shutdown
const shutdown = async () => {
  console.log('[soc-worker] Shutting down...');
  await stopMaintenance();
  await worker.close();
  await redis.quit();
  await pool.end();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
