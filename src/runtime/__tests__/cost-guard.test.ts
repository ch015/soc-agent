/**
 * M11: CostGuard unit tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkCostGuard,
  createCostAccumulator,
  parseCostGuardPolicy,
  recordPhaseAttempt,
  resetPhaseAccumulator,
  type CostAccumulator,
  type CostGuardPolicy,
} from '../workflow/cost-guard.js';

describe('parseCostGuardPolicy', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    // Restore environment
    delete process.env.NUNCHI_MAX_COST_USD;
    delete process.env.NUNCHI_MAX_PHASE_COST_USD;
    delete process.env.NUNCHI_MAX_SESSION_TOKENS;
    delete process.env.NUNCHI_MAX_PHASE_ATTEMPTS;
  });

  it('returns defaults when no env or overrides', () => {
    const policy = parseCostGuardPolicy();
    expect(policy.maxAttemptsPerPhase).toBe(3);
    expect(policy.maxTotalCostUsd).toBeUndefined();
    expect(policy.maxCostPerPhaseUsd).toBeUndefined();
    expect(policy.maxTokensPerSession).toBeUndefined();
  });

  it('reads from environment variables', () => {
    process.env.NUNCHI_MAX_COST_USD = '25.5';
    process.env.NUNCHI_MAX_PHASE_COST_USD = '5.0';
    process.env.NUNCHI_MAX_SESSION_TOKENS = '100000';
    process.env.NUNCHI_MAX_PHASE_ATTEMPTS = '5';

    const policy = parseCostGuardPolicy();
    expect(policy.maxTotalCostUsd).toBe(25.5);
    expect(policy.maxCostPerPhaseUsd).toBe(5.0);
    expect(policy.maxTokensPerSession).toBe(100000);
    expect(policy.maxAttemptsPerPhase).toBe(5);
  });

  it('overrides take precedence over env', () => {
    process.env.NUNCHI_MAX_COST_USD = '25.5';

    const policy = parseCostGuardPolicy({ maxTotalCostUsd: 100 });
    expect(policy.maxTotalCostUsd).toBe(100);
  });

  it('treats NaN env values as unset', () => {
    process.env.NUNCHI_MAX_COST_USD = 'abc';
    process.env.NUNCHI_MAX_PHASE_COST_USD = '';
    process.env.NUNCHI_MAX_SESSION_TOKENS = 'not-a-number';
    process.env.NUNCHI_MAX_PHASE_ATTEMPTS = 'NaN';

    const policy = parseCostGuardPolicy();
    expect(policy.maxTotalCostUsd).toBeUndefined();
    expect(policy.maxCostPerPhaseUsd).toBeUndefined();
    expect(policy.maxTokensPerSession).toBeUndefined();
    expect(policy.maxAttemptsPerPhase).toBe(3); // falls back to default
  });
});

describe('CostAccumulator operations', () => {
  it('createCostAccumulator initializes with zero', () => {
    const acc = createCostAccumulator();
    expect(acc.totalCostUsd).toBe(0);
    expect(acc.currentPhaseCostUsd).toBe(0);
    expect(acc.currentPhaseTokens).toBe(0);
    expect(acc.currentPhaseAttempts).toBe(0);
  });

  it('createCostAccumulator initializes with given total', () => {
    const acc = createCostAccumulator(10.5);
    expect(acc.totalCostUsd).toBe(10.5);
  });

  it('recordPhaseAttempt accumulates correctly', () => {
    const acc = createCostAccumulator(5);
    recordPhaseAttempt(acc, 1.5, 5000);
    expect(acc.totalCostUsd).toBe(6.5);
    expect(acc.currentPhaseCostUsd).toBe(1.5);
    expect(acc.currentPhaseTokens).toBe(5000);
    expect(acc.currentPhaseAttempts).toBe(1);

    recordPhaseAttempt(acc, 2.0, 3000);
    expect(acc.totalCostUsd).toBe(8.5);
    expect(acc.currentPhaseCostUsd).toBe(3.5);
    expect(acc.currentPhaseTokens).toBe(8000);
    expect(acc.currentPhaseAttempts).toBe(2);
  });

  it('resetPhaseAccumulator clears per-phase state', () => {
    const acc = createCostAccumulator(5);
    recordPhaseAttempt(acc, 2.0, 3000);
    resetPhaseAccumulator(acc);
    expect(acc.totalCostUsd).toBe(7.0); // total preserved
    expect(acc.currentPhaseCostUsd).toBe(0);
    expect(acc.currentPhaseTokens).toBe(0);
    expect(acc.currentPhaseAttempts).toBe(0);
  });
});

describe('checkCostGuard', () => {
  it('allows when under all limits', () => {
    const policy: CostGuardPolicy = {
      maxAttemptsPerPhase: 3,
      maxTotalCostUsd: 50,
      maxCostPerPhaseUsd: 10,
      maxTokensPerSession: 200000,
    };
    const acc = createCostAccumulator(10);
    recordPhaseAttempt(acc, 2, 50000);

    const decision = checkCostGuard(policy, acc);
    expect(decision.allowed).toBe(true);
  });

  it('blocks on attempt cap', () => {
    const policy: CostGuardPolicy = { maxAttemptsPerPhase: 2 };
    const acc = createCostAccumulator();
    recordPhaseAttempt(acc, 1, 1000);
    recordPhaseAttempt(acc, 1, 1000);

    const decision = checkCostGuard(policy, acc);
    expect(decision.allowed).toBe(false);
    expect(decision.limitHit).toBe('phase-attempts');
  });

  it('blocks on total cost cap', () => {
    const policy: CostGuardPolicy = { maxAttemptsPerPhase: 3, maxTotalCostUsd: 10 };
    const acc = createCostAccumulator(10);

    const decision = checkCostGuard(policy, acc);
    expect(decision.allowed).toBe(false);
    expect(decision.limitHit).toBe('total-cost');
    expect(decision.reason).toContain('run 전체 비용 상한 초과');
  });

  it('blocks on per-phase cost cap', () => {
    const policy: CostGuardPolicy = { maxAttemptsPerPhase: 5, maxCostPerPhaseUsd: 3 };
    const acc = createCostAccumulator();
    recordPhaseAttempt(acc, 2, 5000);
    recordPhaseAttempt(acc, 1.5, 5000);

    const decision = checkCostGuard(policy, acc);
    expect(decision.allowed).toBe(false);
    expect(decision.limitHit).toBe('phase-cost');
    expect(decision.reason).toContain('phase 비용 상한 초과');
  });

  it('blocks on session token cap', () => {
    const policy: CostGuardPolicy = { maxAttemptsPerPhase: 5, maxTokensPerSession: 100000 };
    const acc = createCostAccumulator();
    recordPhaseAttempt(acc, 1, 60000);
    recordPhaseAttempt(acc, 1, 50000);

    const decision = checkCostGuard(policy, acc);
    expect(decision.allowed).toBe(false);
    expect(decision.limitHit).toBe('session-tokens');
    expect(decision.reason).toContain('session 토큰 상한 초과');
  });

  it('does not check undefined limits', () => {
    const policy: CostGuardPolicy = { maxAttemptsPerPhase: 10 };
    const acc = createCostAccumulator(999);
    recordPhaseAttempt(acc, 100, 9999999);

    const decision = checkCostGuard(policy, acc);
    expect(decision.allowed).toBe(true);
  });

  it('allows when total cost is just below limit', () => {
    const policy: CostGuardPolicy = { maxAttemptsPerPhase: 3, maxTotalCostUsd: 10 };
    const acc = createCostAccumulator(9.99);

    const decision = checkCostGuard(policy, acc);
    expect(decision.allowed).toBe(true);
  });

  it('allows when phase cost is just below limit', () => {
    const policy: CostGuardPolicy = { maxAttemptsPerPhase: 5, maxCostPerPhaseUsd: 3 };
    const acc = createCostAccumulator();
    recordPhaseAttempt(acc, 2.99, 5000);

    const decision = checkCostGuard(policy, acc);
    expect(decision.allowed).toBe(true);
  });

  it('allows when tokens are just below limit', () => {
    const policy: CostGuardPolicy = { maxAttemptsPerPhase: 5, maxTokensPerSession: 100000 };
    const acc = createCostAccumulator();
    recordPhaseAttempt(acc, 1, 99999);

    const decision = checkCostGuard(policy, acc);
    expect(decision.allowed).toBe(true);
  });

  it('checks limits in priority order: attempts > total > phase > tokens', () => {
    const policy: CostGuardPolicy = {
      maxAttemptsPerPhase: 1,
      maxTotalCostUsd: 1,
      maxCostPerPhaseUsd: 1,
      maxTokensPerSession: 1,
    };
    const acc = createCostAccumulator(100);
    recordPhaseAttempt(acc, 100, 100000);

    // All limits are exceeded but attempt cap is checked first
    const decision = checkCostGuard(policy, acc);
    expect(decision.limitHit).toBe('phase-attempts');
  });
});
