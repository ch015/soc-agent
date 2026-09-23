/** Gateway HTTP server — Hono app + @hono/node-server. */
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import Redis from 'ioredis';

import { loadConfig, getConfig } from './config.js';
import { createPool } from './job/store.js';
import { registerRoutes } from './router.js';
import { startDeliveryMaintenance } from './job/outbox.js';
import { initResultRouter } from './result/router.js';

export function createApp() {
  const config = loadConfig();
  const app = new Hono();

  // PostgreSQL pool
  const pool = createPool(config.DATABASE_URL);

  // Redis connection for BullMQ
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

  // Initialize result router
  initResultRouter(() => config.SLACK_BOT_TOKEN);

  // Register routes
  registerRoutes(app, pool, redis);

  const stopMaintenance = startDeliveryMaintenance(pool, redis, 'soc');
  return { app, pool, redis, config, stopMaintenance };
}

/* istanbul ignore next -- entry point guard */
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const { app, config, pool, redis, stopMaintenance } = createApp();
  const server = serve({
    fetch: app.fetch,
    port: config.PORT,
    hostname: config.HOST,
  });
  console.log(`[gateway] Listening on ${config.HOST}:${config.PORT}`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[gateway] Shutting down...');
    server.close();
    await stopMaintenance();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export default createApp;
