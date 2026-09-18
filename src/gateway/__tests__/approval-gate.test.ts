/** Tests for ApprovalGate: policy evaluation, auto-approve, block, manual, escalation. */
import { describe, it, expect } from 'vitest';

import { ApprovalGate } from '../approval/gate.js';
import { createDefaultPolicy, parseTimeout } from '../approval/policy.js';
import type { ApprovalPolicy } from '../approval/policy.js';
import type { AdvisoryAction } from '../adapters/soc/types.js';

function makeAction(overrides: Partial<AdvisoryAction> = {}): AdvisoryAction {
  return {
    actionKey: 'action-001',
    actionType: 'notify-team',
    category: 'observe',
    target: 'soc-team',
    severity: 'high',
    confidence: 0.9,
    evidenceLocators: ['log:entry-001'],
    ...overrides,
  };
}

describe('ApprovalGate', () => {
  describe('Auto-approve observe actions', () => {
    it('auto-approves observe category actions', () => {
      const gate = new ApprovalGate();
      const action = makeAction({ category: 'observe', actionType: 'notify-team' });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('auto-approved');
      expect(result.matchedPolicyRule).toBe('auto-approve-observe');
    });

    it('auto-approves increase-monitoring (observe)', () => {
      const gate = new ApprovalGate();
      const action = makeAction({ category: 'observe', actionType: 'increase-monitoring' });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('auto-approved');
    });

    it('auto-approves create-incident (observe)', () => {
      const gate = new ApprovalGate();
      const action = makeAction({ category: 'observe', actionType: 'create-incident' });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('auto-approved');
    });
  });

  describe('Auto-approve critical containment', () => {
    it('auto-approves block-ip when severity=critical and confidence >= 0.8', () => {
      const gate = new ApprovalGate();
      const action = makeAction({
        category: 'contain',
        actionType: 'block-ip',
        severity: 'critical',
        confidence: 0.9,
      });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('auto-approved');
      expect(result.matchedPolicyRule).toBe('auto-approve-critical-containment');
    });

    it('auto-approves revoke-token when severity=critical and confidence >= 0.8', () => {
      const gate = new ApprovalGate();
      const action = makeAction({
        category: 'eradicate',
        actionType: 'revoke-token',
        severity: 'critical',
        confidence: 0.85,
      });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('auto-approved');
    });

    it('requires manual for block-ip when severity=high (not critical)', () => {
      const gate = new ApprovalGate();
      const action = makeAction({
        category: 'contain',
        actionType: 'block-ip',
        severity: 'high',
        confidence: 0.9,
      });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('manually-approved');
    });

    it('requires manual for block-ip when confidence below threshold', () => {
      const gate = new ApprovalGate();
      const action = makeAction({
        category: 'contain',
        actionType: 'block-ip',
        severity: 'critical',
        confidence: 0.6, // below 0.8 threshold
      });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('manually-approved');
    });
  });

  describe('Block dangerous actions', () => {
    it('blocks delete-data action', () => {
      const gate = new ApprovalGate();
      const action = makeAction({ actionType: 'delete-data', category: 'eradicate' });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('blocked');
      expect(result.rationale).toContain('blocked list');
    });

    it('blocks shutdown-service action', () => {
      const gate = new ApprovalGate();
      const action = makeAction({ actionType: 'shutdown-service', category: 'eradicate' });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('blocked');
    });

    it('blocks drop-database action', () => {
      const gate = new ApprovalGate();
      const action = makeAction({ actionType: 'drop-database', category: 'eradicate' });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('blocked');
    });

    it('blocks wipe-logs action', () => {
      const gate = new ApprovalGate();
      const action = makeAction({ actionType: 'wipe-logs', category: 'eradicate' });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('blocked');
    });
  });

  describe('Manual approval for contain actions', () => {
    it('requires manual for disable-user', () => {
      const gate = new ApprovalGate();
      const action = makeAction({ category: 'contain', actionType: 'disable-user', severity: 'high' });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('manually-approved');
    });

    it('requires manual for isolate-host', () => {
      const gate = new ApprovalGate();
      const action = makeAction({ category: 'contain', actionType: 'isolate-host', severity: 'high' });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('manually-approved');
    });

    it('requires manual for update-waf-rule', () => {
      const gate = new ApprovalGate();
      const action = makeAction({ category: 'contain', actionType: 'update-waf-rule', severity: 'high' });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('manually-approved');
    });
  });

  describe('evaluateAll — batch classification', () => {
    it('groups actions into auto, manual, and blocked', () => {
      const gate = new ApprovalGate();
      const actions: AdvisoryAction[] = [
        makeAction({ actionKey: 'a1', category: 'observe', actionType: 'notify-team' }),
        makeAction({ actionKey: 'a2', category: 'contain', actionType: 'block-ip', severity: 'critical', confidence: 0.9 }),
        makeAction({ actionKey: 'a3', category: 'contain', actionType: 'isolate-host', severity: 'high' }),
        makeAction({ actionKey: 'a4', actionType: 'delete-data', category: 'eradicate' }),
      ];

      const { autoApproved, manualRequired, blocked } = gate.evaluateAll(actions);

      expect(autoApproved).toHaveLength(2); // observe + critical block-ip
      expect(manualRequired).toHaveLength(1); // isolate-host
      expect(blocked).toHaveLength(1); // delete-data
    });
  });

  describe('Timeout and Escalation policy', () => {
    it('parseTimeout handles minutes', () => {
      expect(parseTimeout('15m')).toBe(900_000);
    });

    it('parseTimeout handles hours', () => {
      expect(parseTimeout('1h')).toBe(3_600_000);
    });

    it('parseTimeout handles seconds', () => {
      expect(parseTimeout('30s')).toBe(30_000);
    });

    it('parseTimeout defaults for invalid format', () => {
      expect(parseTimeout('invalid')).toBe(900_000); // 15m default
    });

    it('default policy has 15m timeout with escalation', () => {
      const policy = createDefaultPolicy();
      expect(policy.manualApproval.timeout).toBe('15m');
      expect(policy.manualApproval.escalation.after).toBe('15m');
      expect(policy.manualApproval.escalation.to).toBe('soc-lead');
    });
  });

  describe('Custom policy', () => {
    it('allows custom auto-approve categories', () => {
      const customPolicy: ApprovalPolicy = {
        autoApprove: {
          categories: ['observe', 'contain'],
          maxSeverityForAuto: 'high',
          requireMinConfidence: 0.7,
          allowedActionTypes: ['block-ip', 'notify-team'],
        },
        manualApproval: {
          channel: 'pagerduty',
          timeout: '5m',
          escalation: { after: '5m', to: 'ciso' },
          quorum: 2,
        },
        blocked: ['shutdown-service'],
      };

      const gate = new ApprovalGate(customPolicy);
      const action = makeAction({ category: 'observe', actionType: 'notify-team' });
      const result = gate.evaluate(action);

      expect(result.decision).toBe('auto-approved');
    });
  });
});
