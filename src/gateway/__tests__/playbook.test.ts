/** Tests for PlaybookExecutor: step sequence, rollback, blast radius, connector dispatch. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { PlaybookExecutor, BlastRadiusExceededError } from '../playbook/executor.js';
import type { Playbook, ActionConnector, ActionResult, PlaybookStep, ExecutionContext } from '../playbook/types.js';

function makeConnector(overrides: Partial<ActionConnector> = {}): ActionConnector {
  return {
    id: 'test-connector',
    supportedActions: ['test-action', 'notify-team'],
    execute: vi.fn().mockResolvedValue({
      success: true,
      affectedEntities: ['entity-1'],
      details: {},
      rollbackCapable: true,
    } satisfies ActionResult),
    rollback: vi.fn().mockResolvedValue({
      success: true,
      affectedEntities: ['entity-1'],
      details: {},
      rollbackCapable: false,
    } satisfies ActionResult),
    healthCheck: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function makePlaybook(overrides: Partial<Playbook> = {}): Playbook {
  return {
    id: 'pb-test',
    name: 'Test Playbook',
    version: '1.0.0',
    category: 'observe',
    trigger: { actionTypes: ['test-action'] },
    steps: [
      { id: 'step-1', action: 'test-action', target: 'target-1', timeout: '30s', continueOnFailure: false },
      { id: 'step-2', action: 'notify-team', target: 'soc-channel', timeout: '30s', continueOnFailure: false },
    ],
    limits: {
      maxExecutionTime: '5m',
      maxAffectedEntities: 10,
      requireConfirmationAbove: 5,
    },
    ...overrides,
  };
}

function makeContext(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    jobId: 'job-001',
    tenantId: 'tenant-001',
    signalId: 'sig-001',
    severity: 'high',
    signal: {},
    ...overrides,
  };
}

describe('PlaybookExecutor', () => {
  let executor: PlaybookExecutor;
  let connector: ActionConnector;

  beforeEach(() => {
    executor = new PlaybookExecutor();
    connector = makeConnector();
    executor.registerConnector(connector);
  });

  describe('Sequential step execution', () => {
    it('executes all steps in order', async () => {
      const playbook = makePlaybook();
      const context = makeContext();
      const record = await executor.execute(playbook, context);

      expect(record.status).toBe('completed');
      expect(record.steps).toHaveLength(2);
      expect(record.steps[0]!.stepId).toBe('step-1');
      expect(record.steps[1]!.stepId).toBe('step-2');
      expect(connector.execute).toHaveBeenCalledTimes(2);
    });

    it('records execution result for each step', async () => {
      const playbook = makePlaybook();
      const context = makeContext();
      const record = await executor.execute(playbook, context);

      expect(record.steps[0]!.status).toBe('success');
      expect(record.steps[1]!.status).toBe('success');
      expect(record.totalAffectedEntities).toBe(2); // 1 per step
    });

    it('returns completed status when all steps succeed', async () => {
      const playbook = makePlaybook();
      const context = makeContext();
      const record = await executor.execute(playbook, context);

      expect(record.status).toBe('completed');
      expect(record.completedAt).toBeDefined();
    });
  });

  describe('Failure and rollback', () => {
    it('triggers rollback when step fails and continueOnFailure=false', async () => {
      const failConnector = makeConnector({
        execute: vi.fn()
          .mockResolvedValueOnce({ success: true, affectedEntities: ['e1'], details: {}, rollbackCapable: true })
          .mockRejectedValueOnce(new Error('Step 2 failed')),
      });
      executor = new PlaybookExecutor();
      executor.registerConnector(failConnector);

      const playbook = makePlaybook();
      const context = makeContext();
      const record = await executor.execute(playbook, context);

      // Should have rolled back (step 1 was successful and rollbackCapable)
      expect(record.status).toBe('rolled_back');
      expect(failConnector.rollback).toHaveBeenCalled();
    });

    it('continues execution when continueOnFailure=true', async () => {
      const failConnector = makeConnector({
        execute: vi.fn()
          .mockResolvedValueOnce({ success: false, affectedEntities: [], details: { error: 'failed' }, rollbackCapable: false })
          .mockResolvedValueOnce({ success: true, affectedEntities: ['e1'], details: {}, rollbackCapable: false }),
      });
      executor = new PlaybookExecutor();
      executor.registerConnector(failConnector);

      const playbook = makePlaybook({
        steps: [
          { id: 'step-1', action: 'test-action', target: 't1', timeout: '30s', continueOnFailure: true },
          { id: 'step-2', action: 'notify-team', target: 't2', timeout: '30s', continueOnFailure: false },
        ],
      });
      const context = makeContext();
      const record = await executor.execute(playbook, context);

      expect(record.status).toBe('completed');
      expect(record.steps[0]!.status).toBe('failed');
      expect(record.steps[1]!.status).toBe('success');
    });

    it('uses playbook-defined rollback steps when available', async () => {
      const failConnector = makeConnector({
        execute: vi.fn()
          .mockResolvedValueOnce({ success: true, affectedEntities: ['e1'], details: {}, rollbackCapable: true })
          .mockRejectedValueOnce(new Error('Step 2 failed'))
          // Rollback step execution:
          .mockResolvedValueOnce({ success: true, affectedEntities: [], details: {}, rollbackCapable: false }),
        rollback: vi.fn(),
      });
      executor = new PlaybookExecutor();
      executor.registerConnector(failConnector);

      const playbook = makePlaybook({
        rollback: [
          { id: 'rb-1', action: 'test-action', target: 'rollback-target', timeout: '30s', continueOnFailure: true },
        ],
      });
      const context = makeContext();
      const record = await executor.execute(playbook, context);

      expect(record.status).toBe('rolled_back');
      // The explicit rollback step should be called (3rd call to execute)
      expect(failConnector.execute).toHaveBeenCalledTimes(3);
    });

    it('escalates when rollback fails', async () => {
      const failConnector = makeConnector({
        execute: vi.fn()
          .mockResolvedValueOnce({ success: true, affectedEntities: ['e1'], details: {}, rollbackCapable: true })
          .mockRejectedValueOnce(new Error('Step 2 failed')),
        rollback: vi.fn().mockRejectedValue(new Error('Rollback also failed')),
      });
      executor = new PlaybookExecutor();
      executor.registerConnector(failConnector);

      const playbook = makePlaybook();
      const context = makeContext();
      const record = await executor.execute(playbook, context);

      expect(record.status).toBe('escalated');
    });
  });

  describe('Blast radius guard', () => {
    it('stops execution when maxAffectedEntities exceeded', async () => {
      const manyEntitiesConnector = makeConnector({
        execute: vi.fn().mockResolvedValue({
          success: true,
          affectedEntities: Array.from({ length: 6 }, (_, i) => `entity-${i}`),
          details: {},
          rollbackCapable: true,
        }),
      });
      executor = new PlaybookExecutor();
      executor.registerConnector(manyEntitiesConnector);

      const playbook = makePlaybook({
        limits: { maxExecutionTime: '5m', maxAffectedEntities: 5, requireConfirmationAbove: 3 },
      });
      const context = makeContext();
      const record = await executor.execute(playbook, context);

      // Should have triggered rollback due to blast radius
      expect(['rolled_back', 'escalated']).toContain(record.status);
    });

    it('proceeds when entity count is within limits', async () => {
      const playbook = makePlaybook({
        limits: { maxExecutionTime: '5m', maxAffectedEntities: 100, requireConfirmationAbove: 50 },
      });
      const context = makeContext();
      const record = await executor.execute(playbook, context);

      expect(record.status).toBe('completed');
    });
  });

  describe('Connector dispatch', () => {
    it('fails step when no connector found for action', async () => {
      const playbook = makePlaybook({
        steps: [
          { id: 'step-1', action: 'unknown-action', target: 't1', timeout: '30s', continueOnFailure: false },
        ],
      });
      const context = makeContext();
      const record = await executor.execute(playbook, context);

      // No connector for 'unknown-action' → failure → rolled_back or escalated
      expect(['rolled_back', 'escalated']).toContain(record.status);
    });

    it('dispatches to correct connector based on action type', async () => {
      const slackConnector = makeConnector({
        id: 'slack',
        supportedActions: ['notify-slack'],
        execute: vi.fn().mockResolvedValue({ success: true, affectedEntities: ['#channel'], details: {}, rollbackCapable: false }),
      });
      const jiraConnector = makeConnector({
        id: 'jira',
        supportedActions: ['create-ticket'],
        execute: vi.fn().mockResolvedValue({ success: true, affectedEntities: ['JIRA-123'], details: {}, rollbackCapable: false }),
      });
      executor = new PlaybookExecutor();
      executor.registerConnector(slackConnector);
      executor.registerConnector(jiraConnector);

      const playbook = makePlaybook({
        steps: [
          { id: 's1', action: 'notify-slack', target: '#soc', timeout: '30s', continueOnFailure: false },
          { id: 's2', action: 'create-ticket', target: 'SOC project', timeout: '30s', continueOnFailure: false },
        ],
      });
      const context = makeContext();
      const record = await executor.execute(playbook, context);

      expect(record.status).toBe('completed');
      expect(slackConnector.execute).toHaveBeenCalledTimes(1);
      expect(jiraConnector.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('BlastRadiusExceededError', () => {
    it('provides current and max values', () => {
      const error = new BlastRadiusExceededError(15, 10);
      expect(error.current).toBe(15);
      expect(error.max).toBe(10);
      expect(error.message).toContain('15');
      expect(error.message).toContain('10');
      expect(error.name).toBe('BlastRadiusExceededError');
    });
  });
});
