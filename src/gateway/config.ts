import { z } from 'zod';

const envSchema = z.object({
  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),

  // PostgreSQL
  DATABASE_URL: z.string().url(),

  // Redis (BullMQ)
  REDIS_URL: z.string().url().default('redis://localhost:6379'),

  // Slack notifications are optional for HTTP-only deployments.
  SLACK_BOT_TOKEN: z.string().default(''),

  // Model defaults
  DEFAULT_MODEL: z.string().default('opus'),
  DEFAULT_REVIEW_MODEL: z.string().default('sonnet'),

  // Operational
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  SSE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

  // SOC — log source
  LOG_SOURCE_ENDPOINT: z.string().url().optional(),
  LOG_SOURCE_TOKEN: z.string().optional(),
  LOG_SOURCE_INDEX: z.string().optional(),

  // SOC — PagerDuty
  PAGERDUTY_ROUTING_KEY: z.string().optional(),

  // SOC — Incident webhook
  INCIDENT_WEBHOOK_URL: z.string().url().optional(),

  // SOC — Jira
  JIRA_BASE_URL: z.string().url().optional(),
  JIRA_EMAIL: z.string().optional(),
  JIRA_API_TOKEN: z.string().optional(),
  JIRA_PROJECT_KEY: z.string().optional(),

  // SOC — Slack webhook (for connector, separate from bot token)
  SLACK_WEBHOOK_URL: z.string().url().optional(),
});

export type GatewayConfig = z.infer<typeof envSchema>;

let _config: GatewayConfig | undefined;

export function loadConfig(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const result = envSchema.safeParse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')));
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid gateway configuration:\n${formatted}`);
  }
  _config = result.data;
  return _config;
}

export function getConfig(): GatewayConfig {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}
