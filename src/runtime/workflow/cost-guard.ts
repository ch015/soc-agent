/**
 * M11: CostGuard — Phase-level and run-level cost safety limits.
 *
 * Provides a policy-based guard that is checked before each phase attempt in engine.ts
 * to prevent runaway costs. Integrates with the existing engine budget system and PhaseMetrics.
 *
 * Integration point: WorkflowHost constructor accepts `costGuardPolicy`. When provided,
 * the retry loop calls checkCostGuard() before each attempt and recordPhaseAttempt()
 * after receiving usage data. The guard supplements (does not replace) the existing
 * `remainingBudget <= 0` check which blocks entire phases.
 *
 * This module does NOT change maximumConcurrency, maximumWorkUnits, provider models,
 * feedback limits, or phase order. It is an additive safety net.
 */

/**
 * Cost guard policy defining hard limits.
 */
export interface CostGuardPolicy {
  /** Maximum attempts per phase (including retries). Default: 3. */
  readonly maxAttemptsPerPhase: number;
  /** Maximum total cost for the entire run (USD). Undefined = no limit. */
  readonly maxTotalCostUsd?: number;
  /** Maximum cost per single phase execution (USD). Undefined = no limit. */
  readonly maxCostPerPhaseUsd?: number;
  /** Maximum input+output tokens per phase session. Undefined = no limit. */
  readonly maxTokensPerSession?: number;
}

/**
 * Accumulated cost state for a run.
 */
export interface CostAccumulator {
  /** Total cost incurred so far (USD). */
  totalCostUsd: number;
  /** Cost incurred in the current phase so far (USD). */
  currentPhaseCostUsd: number;
  /** Total tokens consumed in the current phase session. */
  currentPhaseTokens: number;
  /** Number of attempts for the current phase (including retries). */
  currentPhaseAttempts: number;
}

/**
 * Result of a cost guard check.
 */
export interface CostGuardDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly limitHit?: 'total-cost' | 'phase-cost' | 'phase-attempts' | 'session-tokens';
}

const DEFAULT_POLICY: CostGuardPolicy = {
  maxAttemptsPerPhase: 3,
};

/**
 * Parse a CostGuardPolicy from environment variables and/or contract defaults.
 * All limits are opt-in; only maxAttemptsPerPhase has a default (3).
 * Invalid (NaN) environment values are treated as unset (no limit).
 */
export function parseCostGuardPolicy(overrides?: Partial<CostGuardPolicy>): CostGuardPolicy {
  const envMaxCost = process.env.NUNCHI_MAX_COST_USD;
  const envMaxPhaseCost = process.env.NUNCHI_MAX_PHASE_COST_USD;
  const envMaxTokens = process.env.NUNCHI_MAX_SESSION_TOKENS;
  const envMaxAttempts = process.env.NUNCHI_MAX_PHASE_ATTEMPTS;

  const parseIntSafe = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    const n = parseInt(value, 10);
    return Number.isNaN(n) ? undefined : n;
  };
  const parseFloatSafe = (value: string | undefined): number | undefined => {
    if (!value) return undefined;
    const n = parseFloat(value);
    return Number.isNaN(n) ? undefined : n;
  };

  return {
    maxAttemptsPerPhase: overrides?.maxAttemptsPerPhase
      ?? parseIntSafe(envMaxAttempts)
      ?? DEFAULT_POLICY.maxAttemptsPerPhase,
    maxTotalCostUsd: overrides?.maxTotalCostUsd
      ?? parseFloatSafe(envMaxCost),
    maxCostPerPhaseUsd: overrides?.maxCostPerPhaseUsd
      ?? parseFloatSafe(envMaxPhaseCost),
    maxTokensPerSession: overrides?.maxTokensPerSession
      ?? parseIntSafe(envMaxTokens),
  };
}

/**
 * Create a fresh CostAccumulator.
 */
export function createCostAccumulator(totalCostUsd = 0): CostAccumulator {
  return {
    totalCostUsd,
    currentPhaseCostUsd: 0,
    currentPhaseTokens: 0,
    currentPhaseAttempts: 0,
  };
}

/**
 * Reset the per-phase counters when transitioning to a new phase.
 */
export function resetPhaseAccumulator(acc: CostAccumulator): void {
  acc.currentPhaseCostUsd = 0;
  acc.currentPhaseTokens = 0;
  acc.currentPhaseAttempts = 0;
}

/**
 * Record a phase attempt's cost and tokens.
 */
export function recordPhaseAttempt(
  acc: CostAccumulator,
  costUsd: number,
  tokens: number,
): void {
  const safeCost = Math.max(0, costUsd);
  const safeTokens = Math.max(0, tokens);
  acc.totalCostUsd += safeCost;
  acc.currentPhaseCostUsd += safeCost;
  acc.currentPhaseTokens += safeTokens;
  acc.currentPhaseAttempts += 1;
}

/**
 * Check whether the next phase attempt is allowed under the policy.
 * Should be called BEFORE starting an attempt.
 */
export function checkCostGuard(
  policy: CostGuardPolicy,
  acc: Readonly<CostAccumulator>,
): CostGuardDecision {
  // Attempt cap
  if (acc.currentPhaseAttempts >= policy.maxAttemptsPerPhase) {
    return {
      allowed: false,
      reason: `phase attempt 상한 초과: ${acc.currentPhaseAttempts} >= ${policy.maxAttemptsPerPhase}`,
      limitHit: 'phase-attempts',
    };
  }

  // Total run cost cap
  if (policy.maxTotalCostUsd !== undefined && acc.totalCostUsd >= policy.maxTotalCostUsd) {
    return {
      allowed: false,
      reason: `run 전체 비용 상한 초과: $${acc.totalCostUsd.toFixed(2)} >= $${policy.maxTotalCostUsd.toFixed(2)}`,
      limitHit: 'total-cost',
    };
  }

  // Per-phase cost cap
  if (policy.maxCostPerPhaseUsd !== undefined && acc.currentPhaseCostUsd >= policy.maxCostPerPhaseUsd) {
    return {
      allowed: false,
      reason: `phase 비용 상한 초과: $${acc.currentPhaseCostUsd.toFixed(2)} >= $${policy.maxCostPerPhaseUsd.toFixed(2)}`,
      limitHit: 'phase-cost',
    };
  }

  // Token cap
  if (policy.maxTokensPerSession !== undefined && acc.currentPhaseTokens >= policy.maxTokensPerSession) {
    return {
      allowed: false,
      reason: `session 토큰 상한 초과: ${acc.currentPhaseTokens} >= ${policy.maxTokensPerSession}`,
      limitHit: 'session-tokens',
    };
  }

  return { allowed: true };
}
