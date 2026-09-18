/** ApprovalPolicy types + default policy factory per design §6.2. */
import type { ActionCategory } from '../adapters/soc/types.js';

export interface ApprovalPolicy {
  /** Auto-approval conditions. */
  autoApprove: {
    categories: ActionCategory[];
    maxSeverityForAuto: 'critical' | 'high' | 'medium' | 'low' | 'info';
    requireMinConfidence: number;
    allowedActionTypes: string[];
  };

  /** Manual approval settings. */
  manualApproval: {
    channel: 'slack' | 'pagerduty' | 'email';
    timeout: string;
    escalation: {
      after: string;
      to: string;
    };
    quorum: number;
  };

  /** Absolutely blocked actions (never auto nor manual). */
  blocked: string[];
}

export type ApprovalDecision =
  | 'auto-approved'
  | 'manually-approved'
  | 'denied'
  | 'escalated'
  | 'blocked'
  | 'timed-out';

/**
 * Create the conservative default policy per design §6.2-6.3:
 * - observe = auto-approve always
 * - contain/eradicate when severity=critical for block-ip/revoke-token only = auto
 * - everything else = manual
 * - destructive actions = blocked
 */
export function createDefaultPolicy(): ApprovalPolicy {
  return {
    autoApprove: {
      categories: ['observe'],
      maxSeverityForAuto: 'high',
      requireMinConfidence: 0.8,
      allowedActionTypes: [
        'increase-monitoring',
        'create-incident',
        'notify-team',
        'block-ip',
        'revoke-token',
      ],
    },
    manualApproval: {
      channel: 'slack',
      timeout: '15m',
      escalation: {
        after: '15m',
        to: 'soc-lead',
      },
      quorum: 1,
    },
    blocked: [
      'delete-data',
      'shutdown-service',
      'drop-database',
      'wipe-logs',
    ],
  };
}

/**
 * Parse timeout string to milliseconds (e.g., '15m' → 900000).
 */
export function parseTimeout(timeout: string): number {
  const match = timeout.match(/^(\d+)(s|m|h)$/);
  if (!match) return 15 * 60 * 1000; // default 15m

  const amount = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case 's': return amount * 1000;
    case 'm': return amount * 60 * 1000;
    case 'h': return amount * 60 * 60 * 1000;
    default: return 15 * 60 * 1000;
  }
}
