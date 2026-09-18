import type { AgentDefinition, OutputFormat } from '@anthropic-ai/claude-agent-sdk';

import type { WorkflowContract, WorkflowPhase } from '../contracts/workflow-contract.js';

/**
 * Phase transition input state — summarizes the run's completed phases and domain-specific context
 * that a DomainAdapter can inspect to decide whether a transition is allowed.
 */
export interface PhaseTransitionState {
  /** Set of phase IDs that have completed at least once. */
  readonly completedPhases: ReadonlySet<string>;
  /** Current run status. */
  readonly runStatus: 'running' | 'awaiting-input' | 'completed' | 'blocked';
  /** Total cost incurred so far (USD). */
  readonly totalCostUsd: number;
  /** Maximum budget for the run (USD), if set. */
  readonly maxBudgetUsd?: number;
  /** Number of completed attempts per phase (useful for feedback iteration counting). */
  readonly completedAttemptsByPhase: Readonly<Record<string, number>>;
}

/**
 * Result of a canTransition check.
 */
export interface TransitionDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Structured validation outcome for validateResultV2. Replaces throw-based control flow
 * with explicit retry/continue/fail signals.
 */
export interface ValidationOutcome<TResult = unknown> {
  /** Disposition of the validation. */
  readonly status: 'pass' | 'retry' | 'record-continue' | 'safety-fail';
  /** Validated result data (present when status === 'pass' or 'record-continue'). */
  readonly data?: TResult;
  /** Human-readable error detail (present when status !== 'pass'). */
  readonly error?: string;
  /** Fields that were automatically corrected during validation. */
  readonly corrections?: Record<string, unknown>;
}

export interface DomainAdapter<TLegacyContract = unknown, TLegacyPhase = unknown, TResult = unknown> {
  readonly domain: string;
  readonly mission: string;
  readonly contract: WorkflowContract;
  readonly legacyContract: TLegacyContract;
  buildAgentDefinitions(): Record<string, AgentDefinition>;
  outputFormat(phase: TLegacyPhase): OutputFormat;
  getPhase(id: string): { workflow: WorkflowPhase; legacy: TLegacyPhase };
  buildPrompt(input: {
    phase: TLegacyPhase;
    target: string;
    engagementDir: string;
    runId: string;
    attempt: string;
    scope?: string;
    round?: string;
    inputs?: Record<string, unknown>;
  }): string;
  validateResult(input: {
    value: unknown;
    phase: TLegacyPhase;
    engagementDir: string;
    round?: string;
  }): TResult;
  validateAcceptedResult?(input: {
    result: TResult;
    phase: TLegacyPhase;
    engagementDir: string;
    round?: string;
  }): void;
  renderArtifacts(phase: TLegacyPhase, round?: string): { required: string[]; optional: string[] };
  /** Artifact names materialized by the host after validating structured output. */
  hostOwnedArtifacts?(phase: TLegacyPhase, round?: string): readonly string[];
  /** Trusted contract resources the host loads and injects with hash receipts. */
  hostPromptResources?(phase: TLegacyPhase): readonly string[];
  /** Hash-pinned domain methodology files available for exact, just-in-time Read. */
  resolveMethodologyFiles?(phase: TLegacyPhase): readonly string[];
  /** Phase-filtered knowledge-base files available for Read. */
  resolveKnowledgeFiles?(phase: TLegacyPhase): readonly string[];
  /** Exact prior artifact names visible to this phase. Undefined preserves legacy behavior. */
  allowedPriorArtifacts?(phase: TLegacyPhase, inputs?: Record<string, unknown>): readonly string[];
  resolveMethodFiles(phase: TLegacyPhase): string[];
  /**
   * Domain-specific transition guard. Returns whether the run may advance from one phase to another
   * given the current run state. Undefined preserves default behavior (contract prerequisite check only).
   */
  canTransition?(from: string, to: string, state: PhaseTransitionState): TransitionDecision;
  /**
   * V2 validation interface returning a structured ValidationOutcome instead of throwing.
   * When implemented, engine.ts uses this for retry decisions instead of wrapping validateResult in try/catch.
   * When absent, engine.ts falls back to wrapping validateResult() with throw → retry heuristic.
   */
  validateResultV2?(input: {
    value: unknown;
    phase: TLegacyPhase;
    engagementDir: string;
    round?: string;
  }): ValidationOutcome<TResult>;
}
