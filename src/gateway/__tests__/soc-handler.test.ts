/** Tests for SOC DomainHandler: registration, lifecycle, analysis→approval→action flow. */
import { describe, it, expect, vi } from 'vitest';

import { DomainHandlerRegistry } from '../workers/runner.js';
import { SocHandler } from '../workers/soc-handler.js';
import { canTransition } from '../job/lifecycle.js';
import type { Job, ResultPayload } from '../job/types.js';
import { ResultRouter } from '../result/router.js';
import type { ResultHandler } from '../result/router.js';
import { ApprovalGate } from '../approval/gate.js';
import type { AdvisoryAction } from '../adapters/soc/types.js';

function makeSocJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'soc-job-001',
    tenantId: 'tenant-001',
    domain: 'soc',
    status: 'queued',
    priority: 2,
    input: {
      domain: 'soc',
      source: { type: 'snapshot' },
      instruction: 'Analyze detection signal from secops-nunchi-detection.',
      options: {
        signal: {
          signalId: 'det-20260812-abc123',
          signalType: 'detection',
          source: 'secops-nunchi-detection',
          severity: 'high',
          timestamp: '2026-08-12T09:15:00Z',
          subject: { type: 'ip', value: '203.0.113.42' },
          rule: { id: 'T1078.004', name: 'Valid Accounts: Cloud Accounts', category: 'initial-access' },
          tenantId: 'tenant-001',
        },
        missionType: 'report',
      },
      callback: { type: 'webhook' },
    },
    callback: { type: 'webhook' },
    progress: null,
    result: null,
    error: null,
    pendingInput: null,
    costUsd: null,
    attempts: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('SOC Handler: DomainHandler Registration', () => {
  it('registers in DomainHandlerRegistry with domain "soc"', () => {
    const registry = new DomainHandlerRegistry();
    const handler = new SocHandler();
    registry.register(handler);

    expect(registry.get('soc')).toBe(handler);
    expect(handler.domain).toBe('soc');
  });


});

describe('SOC Handler: Lifecycle Transitions', () => {
  it('SOC job follows queued → running → completed lifecycle', () => {
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
  });

  it('SOC job can transition running → action_pending', () => {
    expect(canTransition('running', 'action_pending')).toBe(true);
  });

  it('SOC job can transition action_pending → action_executing', () => {
    expect(canTransition('action_pending', 'action_executing')).toBe(true);
  });

  it('SOC job can transition action_pending → cancelled', () => {
    expect(canTransition('action_pending', 'cancelled')).toBe(true);
  });

  it('SOC job can transition action_pending → completed (deny)', () => {
    expect(canTransition('action_pending', 'completed')).toBe(true);
  });

  it('SOC job can transition action_executing → completed', () => {
    expect(canTransition('action_executing', 'completed')).toBe(true);
  });

  it('SOC job can transition action_executing → failed', () => {
    expect(canTransition('action_executing', 'failed')).toBe(true);
  });

  it('existing Phase 1/2 jobs are unaffected by new states', () => {
    // Existing transitions still work
    expect(canTransition('queued', 'running')).toBe(true);
    expect(canTransition('running', 'waiting')).toBe(true);
    expect(canTransition('running', 'failed')).toBe(true);
    expect(canTransition('waiting', 'running')).toBe(true);
    expect(canTransition('failed', 'queued')).toBe(true);

    // Existing terminal states remain terminal
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('cancelled', 'running')).toBe(false);
    expect(canTransition('rejected', 'running')).toBe(false);
  });
});

describe('SOC Handler: Analysis → Approval → Action Flow', () => {
  it('auto-approves observe actions without entering action_pending', () => {
    const gate = new ApprovalGate();
    const actions: AdvisoryAction[] = [
      {
        actionKey: 'notify-001',
        actionType: 'notify-team',
        category: 'observe',
        target: 'soc-channel',
        severity: 'high',
        confidence: 0.9,
        evidenceLocators: ['log:001'],
      },
    ];

    const { autoApproved, manualRequired, blocked } = gate.evaluateAll(actions);
    expect(autoApproved).toHaveLength(1);
    expect(manualRequired).toHaveLength(0);
    expect(blocked).toHaveLength(0);
  });

  it('requires manual approval for contain actions (non-critical severity)', () => {
    const gate = new ApprovalGate();
    const actions: AdvisoryAction[] = [
      {
        actionKey: 'block-001',
        actionType: 'isolate-host',
        category: 'contain',
        target: 'web-prod-01',
        severity: 'high',
        confidence: 0.85,
        evidenceLocators: ['log:002'],
      },
    ];

    const { autoApproved, manualRequired } = gate.evaluateAll(actions);
    expect(autoApproved).toHaveLength(0);
    expect(manualRequired).toHaveLength(1);
  });

  it('auto-approves critical block-ip with high confidence', () => {
    const gate = new ApprovalGate();
    const actions: AdvisoryAction[] = [
      {
        actionKey: 'block-ip-001',
        actionType: 'block-ip',
        category: 'contain',
        target: '203.0.113.42',
        severity: 'critical',
        confidence: 0.95,
        evidenceLocators: ['log:003'],
      },
    ];

    const { autoApproved } = gate.evaluateAll(actions);
    expect(autoApproved).toHaveLength(1);
    expect(autoApproved[0]!.matchedPolicyRule).toBe('auto-approve-critical-containment');
  });

  it('blocks dangerous actions regardless of severity', () => {
    const gate = new ApprovalGate();
    const actions: AdvisoryAction[] = [
      {
        actionKey: 'delete-001',
        actionType: 'delete-data',
        category: 'eradicate',
        target: 'compromised-db',
        severity: 'critical',
        confidence: 1.0,
        evidenceLocators: ['log:004'],
      },
    ];

    const { blocked } = gate.evaluateAll(actions);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.decision).toBe('blocked');
  });
});

describe('SOC Handler: Result Routing', () => {
  it('routes completed result to webhook handler', async () => {
    const router = new ResultRouter();
    const received: Array<{ job: Job; payload: ResultPayload }> = [];

    const handler: ResultHandler = {
      type: 'webhook',
      async handle(job, payload) {
        received.push({ job, payload });
      },
    };
    router.register('webhook', handler);

    const job = makeSocJob({ status: 'completed' });
    const payload: ResultPayload = {
      type: 'completed',
      summary: 'SOC report 완료 — high signal from secops-nunchi-detection',
    };
    await router.route(job, payload);

    expect(received).toHaveLength(1);
    expect(received[0]!.payload.type).toBe('completed');
  });

  it('routes escalation to pagerduty handler', async () => {
    const router = new ResultRouter();
    const received: Array<{ job: Job; payload: ResultPayload }> = [];

    const handler: ResultHandler = {
      type: 'pagerduty',
      async handle(job, payload) {
        received.push({ job, payload });
      },
    };
    router.register('pagerduty', handler);

    const job = makeSocJob({ callback: { type: 'pagerduty' }, status: 'failed' });
    const payload: ResultPayload = {
      type: 'failed',
      error: 'ESCALATION: Playbook rollback failed',
    };
    await router.route(job, payload);

    expect(received).toHaveLength(1);
    expect(received[0]!.payload.error).toContain('ESCALATION');
  });

  it('keeps a missing callback handler retryable', async () => {
    const router = new ResultRouter();
    const job = makeSocJob({ callback: { type: 'incident' } });

    await expect(
      router.route(job, { type: 'completed', summary: 'Done' }),
    ).rejects.toThrow('No result handler');
  });
});

describe('SOC Handler: Process Guards', () => {
  it('requires signal in input.options', async () => {
    const handler = new SocHandler();
    const job = makeSocJob();
    job.input.options = {}; // No signal

    const mockPool = {
      query: async () => ({ rows: [{ id: 1 }], rowCount: 1 }),
    } as unknown as import('../job/store.js').PgPool;

    await expect(handler.process(job, mockPool)).rejects.toThrow(/missing signal/);
  });
});
