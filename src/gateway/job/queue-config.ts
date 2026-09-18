/** Per-domain queue configurations — concurrency, retry, timeout, dedup. */
import type { DomainType } from './types.js';

export interface DomainQueueConfig {
  domain: string;
  concurrency: number;
  priority: boolean;
  rateLimiter?: {
    max: number;
    duration: number;
    groupKey?: string;
  };
  retry: {
    attempts: number;
    backoff: { type: 'exponential' | 'fixed'; delay: number };
  };
  timeout: number; // ms
  deduplication?: {
    windowMs: number;
  };
}

export const QUEUE_CONFIGS: Record<DomainType, DomainQueueConfig> = {
  soc: {
    domain: 'soc',
    concurrency: 6,
    priority: true,
    // rateLimiter: undefined — unlimited
    retry: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 10_000 },
    },
    timeout: 600_000, // 10 min
    deduplication: { windowMs: 300_000 }, // 5 min
  },
};

/** Get queue config for a domain. Throws if domain is unknown. */
export function getQueueConfig(domain: DomainType): DomainQueueConfig {
  const config = QUEUE_CONFIGS[domain];
  if (!config) {
    throw new Error(`No queue config for domain: ${domain}`);
  }
  return config;
}
