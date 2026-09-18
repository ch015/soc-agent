/** Severity → BullMQ priority number mapping per design §4.2. */
import { SEVERITY_PRIORITY_MAP } from './types.js';
import type { SocSeverity } from './types.js';

/**
 * Map SOC severity to BullMQ queue priority.
 * Lower number = higher priority.
 *
 * | Severity | Priority | SLA             |
 * |----------|----------|-----------------|
 * | critical | 1        | < 2min start    |
 * | high     | 2        | < 5min          |
 * | medium   | 3        | < 15min         |
 * | low      | 4        | < 1hr           |
 * | info     | 5        | batch-eligible  |
 */
export function severityToPriority(severity: SocSeverity): number {
  return SEVERITY_PRIORITY_MAP[severity];
}

/**
 * Determine if a severity level warrants immediate processing (skip batch).
 */
export function isImmediatePriority(severity: SocSeverity): boolean {
  return severity === 'critical' || severity === 'high';
}

/**
 * Determine lock duration based on severity.
 * Critical/high jobs get longer locks because they trigger more complex flows.
 */
export function lockDurationForSeverity(severity: SocSeverity): number {
  switch (severity) {
    case 'critical':
    case 'high':
      return 600_000; // 10 min
    case 'medium':
      return 600_000; // 10 min
    case 'low':
    case 'info':
      return 300_000; // 5 min
  }
}
