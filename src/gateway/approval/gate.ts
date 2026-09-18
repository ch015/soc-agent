/**
 * ApprovalGate — evaluates AdvisoryActions against policy.
 * Classifies as auto-approved / manual / blocked per design §6.2-6.3.
 *
 * Rules:
 * - observe category → always auto-approve
 * - contain/eradicate + severity=critical + action is block-ip or revoke-token → auto-approve
 * - everything else → manual approval required
 * - blocked list → unconditional reject
 */
import type { AdvisoryAction, SocSeverity } from '../adapters/soc/types.js';
import type { ApprovalPolicy, ApprovalDecision } from './policy.js';
import { createDefaultPolicy } from './policy.js';
import { appendAuditEvent } from './audit.js';
import type { PgPool } from '../job/store.js';

export interface ApprovalResult {
  decision: ApprovalDecision;
  actionKey: string;
  actionType: string;
  rationale: string;
  matchedPolicyRule: string;
}

/**
 * ApprovalGate — evaluates a set of advisory actions against policy.
 */
export class ApprovalGate {
  private readonly policy: ApprovalPolicy;

  constructor(policy?: ApprovalPolicy) {
    this.policy = policy ?? createDefaultPolicy();
  }

  /**
   * Evaluate a single action against policy.
   */
  evaluate(action: AdvisoryAction): ApprovalResult {
    // 1. Check blocked list first
    if (this.policy.blocked.includes(action.actionType)) {
      return {
        decision: 'blocked',
        actionKey: action.actionKey,
        actionType: action.actionType,
        rationale: `Action type "${action.actionType}" is in blocked list`,
        matchedPolicyRule: 'blocked-list',
      };
    }

    // 2. Check auto-approve conditions
    if (this.shouldAutoApprove(action)) {
      return {
        decision: 'auto-approved',
        actionKey: action.actionKey,
        actionType: action.actionType,
        rationale: this.getAutoApproveRationale(action),
        matchedPolicyRule: this.getMatchedRule(action),
      };
    }

    // 3. Default: manual approval required
    return {
      decision: 'manually-approved', // placeholder — will actually be pending
      actionKey: action.actionKey,
      actionType: action.actionType,
      rationale: `Action requires manual approval: category=${action.category}, type=${action.actionType}`,
      matchedPolicyRule: 'manual-default',
    };
  }

  /**
   * Evaluate all actions and return results grouped by decision.
   */
  evaluateAll(actions: AdvisoryAction[]): {
    autoApproved: ApprovalResult[];
    manualRequired: ApprovalResult[];
    blocked: ApprovalResult[];
  } {
    const autoApproved: ApprovalResult[] = [];
    const manualRequired: ApprovalResult[] = [];
    const blocked: ApprovalResult[] = [];

    for (const action of actions) {
      const result = this.evaluate(action);
      switch (result.decision) {
        case 'auto-approved':
          autoApproved.push(result);
          break;
        case 'blocked':
          blocked.push(result);
          break;
        default:
          // Reclassify the placeholder decision as needing manual
          result.decision = 'manually-approved';
          manualRequired.push(result);
          break;
      }
    }

    return { autoApproved, manualRequired, blocked };
  }

  /**
   * Record approval decision as audit event.
   */
  async recordDecision(
    pool: PgPool,
    jobId: string,
    result: ApprovalResult,
    action: AdvisoryAction,
    policyVersion: string,
  ): Promise<void> {
    await appendAuditEvent(pool, {
      jobId,
      actionKey: result.actionKey,
      actionType: result.actionType,
      decision: result.decision,
      decidedBy: result.decision === 'auto-approved' ? 'policy:auto' : 'system:pending',
      decidedAt: new Date().toISOString(),
      policyVersion,
      rationale: result.rationale,
      evidence: {
        signalSeverity: action.severity,
        analysisConfidence: action.confidence,
        matchedPolicyRule: result.matchedPolicyRule,
      },
    });
  }

  private shouldAutoApprove(action: AdvisoryAction): boolean {
    const { autoApprove } = this.policy;

    // Rule 1: observe category is always auto-approved
    if (action.category === 'observe' && autoApprove.categories.includes('observe')) {
      return true;
    }

    // Rule 2: contain/eradicate + critical severity + allowed action types (block-ip, revoke-token)
    if (
      (action.category === 'contain' || action.category === 'eradicate') &&
      action.severity === 'critical' &&
      (action.actionType === 'block-ip' || action.actionType === 'revoke-token')
    ) {
      // Must also meet confidence threshold
      if (action.confidence >= autoApprove.requireMinConfidence) {
        return true;
      }
    }

    return false;
  }

  private getAutoApproveRationale(action: AdvisoryAction): string {
    if (action.category === 'observe') {
      return `Observe actions are auto-approved by policy`;
    }
    return `Critical severity ${action.actionType} auto-approved: confidence=${action.confidence}`;
  }

  private getMatchedRule(action: AdvisoryAction): string {
    if (action.category === 'observe') {
      return 'auto-approve-observe';
    }
    return 'auto-approve-critical-containment';
  }
}
