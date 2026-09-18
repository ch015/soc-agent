/**
 * PlaybookExecutor — sequential step execution with rollback on failure.
 *
 * - Runs steps sequentially.
 * - If a step fails and continueOnFailure=false, rollback in reverse order.
 * - maxAffectedEntities guard: abort if blast radius exceeded.
 * - If rollback fails → emit escalation via ResultRouter (type 'pagerduty').
 */
import type {
  Playbook,
  PlaybookStep,
  ActionConnector,
  ActionResult,
  ExecutionContext,
  PlaybookExecutionRecord,
  StepExecutionRecord,
} from './types.js';
import { resultRouter } from '../result/router.js';
import type { Job } from '../job/types.js';
import { parseTimeout } from '../approval/policy.js';

export class BlastRadiusExceededError extends Error {
  constructor(
    public readonly current: number,
    public readonly max: number,
  ) {
    super(`Blast radius exceeded: ${current} entities affected (max: ${max})`);
    this.name = 'BlastRadiusExceededError';
  }
}

export class PlaybookExecutor {
  private connectors = new Map<string, ActionConnector>();

  /**
   * Register an action connector.
   */
  registerConnector(connector: ActionConnector): void {
    this.connectors.set(connector.id, connector);
  }

  /**
   * Find connector that supports a given action.
   */
  private findConnector(action: string): ActionConnector | undefined {
    for (const connector of this.connectors.values()) {
      if (connector.supportedActions.includes(action)) {
        return connector;
      }
    }
    return undefined;
  }

  /**
   * Execute a playbook. Returns the execution record.
   */
  async execute(
    playbook: Playbook,
    context: ExecutionContext,
  ): Promise<PlaybookExecutionRecord> {
    const record: PlaybookExecutionRecord = {
      id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      jobId: context.jobId,
      playbookId: playbook.id,
      status: 'running',
      steps: [],
      startedAt: new Date().toISOString(),
      totalAffectedEntities: 0,
    };

    const executedSteps: Array<{ step: PlaybookStep; result: ActionResult }> = [];

    try {
      for (const step of playbook.steps) {
        // Check blast radius before each step
        if (record.totalAffectedEntities >= playbook.limits.maxAffectedEntities) {
          throw new BlastRadiusExceededError(
            record.totalAffectedEntities,
            playbook.limits.maxAffectedEntities,
          );
        }

        const connector = this.findConnector(step.action);
        if (!connector) {
          const stepRecord: StepExecutionRecord = {
            stepId: step.id,
            action: step.action,
            status: 'failed',
            error: `No connector found for action: ${step.action}`,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          };
          record.steps.push(stepRecord);

          if (!step.continueOnFailure) {
            throw new Error(`No connector for action: ${step.action}`);
          }
          continue;
        }

        const stepStart = new Date().toISOString();

        try {
          // Execute with timeout
          const timeoutMs = parseTimeout(step.timeout);
          const result = await withTimeout(
            connector.execute(step, context),
            timeoutMs,
          );

          record.totalAffectedEntities += result.affectedEntities.length;

          // Re-check blast radius after step
          if (record.totalAffectedEntities > playbook.limits.maxAffectedEntities) {
            throw new BlastRadiusExceededError(
              record.totalAffectedEntities,
              playbook.limits.maxAffectedEntities,
            );
          }

          const stepRecord: StepExecutionRecord = {
            stepId: step.id,
            action: step.action,
            status: result.success ? 'success' : 'failed',
            result,
            startedAt: stepStart,
            completedAt: new Date().toISOString(),
          };
          record.steps.push(stepRecord);

          if (result.success) {
            executedSteps.push({ step, result });
          } else if (!step.continueOnFailure) {
            throw new Error(`Step ${step.id} failed: ${JSON.stringify(result.details)}`);
          }
        } catch (err) {
          if (err instanceof BlastRadiusExceededError) throw err;

          const stepRecord: StepExecutionRecord = {
            stepId: step.id,
            action: step.action,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
            startedAt: stepStart,
            completedAt: new Date().toISOString(),
          };
          record.steps.push(stepRecord);

          if (!step.continueOnFailure) throw err;
        }
      }

      // All steps completed successfully
      record.status = 'completed';
      record.completedAt = new Date().toISOString();
    } catch (err) {
      // Attempt rollback
      const rollbackSuccess = await this.rollback(
        executedSteps,
        playbook,
        context,
        record,
      );

      if (rollbackSuccess) {
        record.status = 'rolled_back';
      } else {
        // Rollback failed → escalation
        record.status = 'escalated';
        await this.emitEscalation(context, playbook, err);
      }

      record.completedAt = new Date().toISOString();
    }

    return record;
  }

  /**
   * Rollback executed steps in reverse order.
   * Returns true if all rollbacks succeeded.
   */
  private async rollback(
    executedSteps: Array<{ step: PlaybookStep; result: ActionResult }>,
    playbook: Playbook,
    context: ExecutionContext,
    record: PlaybookExecutionRecord,
  ): Promise<boolean> {
    // Use playbook-defined rollback steps if available
    const rollbackSteps = playbook.rollback ?? [];

    if (rollbackSteps.length > 0) {
      let allSuccess = true;
      for (const step of rollbackSteps) {
        const connector = this.findConnector(step.action);
        if (!connector) {
          allSuccess = false;
          continue;
        }
        try {
          const result = await connector.execute(step, context);
          if (!result.success) allSuccess = false;
        } catch {
          allSuccess = false;
        }
      }
      return allSuccess;
    }

    // Fallback: rollback in reverse using connector rollback methods
    let allSuccess = true;
    for (let i = executedSteps.length - 1; i >= 0; i--) {
      const { step, result } = executedSteps[i]!;
      if (!result.rollbackCapable) continue;

      const connector = this.findConnector(step.action);
      if (!connector?.rollback) {
        allSuccess = false;
        continue;
      }

      try {
        const rollbackResult = await connector.rollback(step, context);
        const stepRecord: StepExecutionRecord = {
          stepId: `rollback-${step.id}`,
          action: `rollback:${step.action}`,
          status: rollbackResult.success ? 'rolled_back' : 'failed',
          result: rollbackResult,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
        record.steps.push(stepRecord);

        if (!rollbackResult.success) allSuccess = false;
      } catch {
        allSuccess = false;
      }
    }

    return allSuccess;
  }

  /**
   * Emit escalation event via PagerDuty result handler.
   */
  private async emitEscalation(
    context: ExecutionContext,
    playbook: Playbook,
    error: unknown,
  ): Promise<void> {
    try {
      const escalationJob: Job = {
        id: context.jobId,
        tenantId: context.tenantId,
        domain: 'soc',
        status: 'failed',
        priority: 1,
        input: {} as Job['input'],
        callback: { type: 'pagerduty' },
        progress: null,
        result: null,
        error: {
          message: `Playbook rollback failed: ${playbook.name}`,
          playbookId: playbook.id,
          originalError: error instanceof Error ? error.message : String(error),
        },
        pendingInput: null,
        costUsd: null,
        attempts: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        startedAt: null,
        completedAt: null,
      };

      await resultRouter.route(escalationJob, {
        type: 'failed',
        error: `ESCALATION: Playbook "${playbook.name}" rollback failed. Manual intervention required.`,
      });
    } catch {
      // Escalation routing failure logged but not re-thrown
      console.error(`[PlaybookExecutor] Failed to emit escalation for job ${context.jobId}`);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Step execution timed out')), timeoutMs);
    promise
      .then((result) => { clearTimeout(timer); resolve(result); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}
