/** Signal deduplication and correlation using Redis TTL keys. */
import type { Redis } from 'ioredis';

import type { SocSignal, SignalDeduplication } from './types.js';

/** Correlation window in seconds (5 minutes). */
const CORRELATION_WINDOW_SEC = 300;

/** Redis key prefix for signal dedup. */
const DEDUP_PREFIX = 'secops-soc:dedup:';

/** Redis key prefix for correlation. */
const CORR_PREFIX = 'secops-soc:corr:';

/**
 * SignalCorrelation — Redis-backed deduplication and correlation.
 *
 * Keys encode tuples so tenant IDs and delimiter-bearing field values cannot collide.
 */
export class SignalCorrelation implements SignalDeduplication {
  constructor(private readonly redis: Redis) {}

  /**
   * Check if signalId has been seen. Returns true if duplicate.
   */
  async bySignalId(tenantId: string, signalId: string): Promise<boolean> {
    const key = `${DEDUP_PREFIX}${JSON.stringify([tenantId, signalId])}`;
    const exists = await this.redis.exists(key);
    return exists === 1;
  }

  /**
   * Check correlation: same subject + rule within 5min window.
   * Returns existing jobId or null.
   */
  async byCorrelation(signal: SocSignal): Promise<string | null> {
    if (!signal.rule) return null;

    const key = buildCorrelationKey(signal);
    const jobId = await this.redis.get(key);
    return jobId;
  }

  /**
   * Mark a signal as seen with its associated jobId.
   * Also sets the correlation key for future dedup.
   */
  async markSeen(tenantId: string, signalId: string, jobId: string): Promise<void> {
    const dedupKey = `${DEDUP_PREFIX}${JSON.stringify([tenantId, signalId])}`;
    await this.redis.set(dedupKey, jobId, 'EX', CORRELATION_WINDOW_SEC);
  }

  /**
   * Set correlation key for a signal→job binding.
   * Called after job creation so subsequent signals with same subject+rule
   * within the window are correlated to the existing job.
   */
  async setCorrelation(signal: SocSignal, jobId: string): Promise<void> {
    if (!signal.rule) return;
    const key = buildCorrelationKey(signal);
    await this.redis.set(key, jobId, 'EX', CORRELATION_WINDOW_SEC);
  }
}

function buildCorrelationKey(signal: SocSignal): string {
  const ruleId = signal.rule?.id ?? 'none';
  return `${CORR_PREFIX}${JSON.stringify([signal.tenantId, signal.subject.type, signal.subject.value, ruleId])}`;
}
