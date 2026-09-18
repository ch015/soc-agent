/** Playbook, PlaybookStep, ActionConnector interface, ActionResult, ActionCategory. */
import type { ActionCategory } from '../adapters/soc/types.js';

export interface Playbook {
  id: string;
  name: string;
  version: string;
  category: ActionCategory;

  /** Execution trigger conditions. */
  trigger: {
    actionTypes: string[];
    signalCategories?: string[];
  };

  /** Sequential execution steps. */
  steps: PlaybookStep[];

  /** Rollback steps (executed in reverse on failure). */
  rollback?: PlaybookStep[];

  /** Execution limits. */
  limits: {
    maxExecutionTime: string;
    maxAffectedEntities: number;
    requireConfirmationAbove: number;
  };
}

export interface PlaybookStep {
  id: string;
  action: string;
  target: string;
  params?: Record<string, unknown>;
  timeout: string;
  continueOnFailure: boolean;
}

export interface ExecutionContext {
  jobId: string;
  tenantId: string;
  signalId: string;
  severity: string;
  signal: Record<string, unknown>;
}

export interface ActionResult {
  success: boolean;
  affectedEntities: string[];
  details: Record<string, unknown>;
  rollbackCapable: boolean;
}

/**
 * ActionConnector — external system integration point.
 * Each connector implements specific infrastructure actions.
 */
export interface ActionConnector {
  id: string;
  supportedActions: string[];
  execute(step: PlaybookStep, context: ExecutionContext): Promise<ActionResult>;
  rollback?(step: PlaybookStep, context: ExecutionContext): Promise<ActionResult>;
  healthCheck(): Promise<boolean>;
}

export interface PlaybookExecutionRecord {
  id: string;
  jobId: string;
  playbookId: string;
  status: 'running' | 'completed' | 'failed' | 'rolled_back' | 'escalated';
  steps: StepExecutionRecord[];
  startedAt: string;
  completedAt?: string;
  totalAffectedEntities: number;
}

export interface StepExecutionRecord {
  stepId: string;
  action: string;
  status: 'success' | 'failed' | 'skipped' | 'rolled_back';
  result?: ActionResult;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export { ActionCategory };
