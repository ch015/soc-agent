import { describe, expect, it } from 'vitest';

import { ModelIndependenceGuard } from '../workflow/model-independence.js';

const usage = (model: string) => ({
  provider: 'anthropic-agent-sdk',
  model,
  modelIdentityVerified: true as const,
  costUsd: 0,
});

describe('ModelIndependenceGuard', () => {
  it('rejects different requested aliases that resolved to the same actual model', () => {
    const guard = new ModelIndependenceGuard();
    guard.observe('primary', usage('claude-sonnet-4'));
    expect(() => guard.observe('review', usage('claude-sonnet-4'))).toThrow(/실제 모델이 같다/);
  });

  it('requires a provider-verified actual identity', () => {
    const guard = new ModelIndependenceGuard();
    expect(() => guard.observe('primary', {
      provider: 'anthropic-agent-sdk',
      model: 'sonnet',
      costUsd: 0,
    })).toThrow(/provider-verified/);
  });

  it('compares provider model identities case-insensitively', () => {
    const guard = new ModelIndependenceGuard();
    guard.observe('primary', usage('claude-sonnet-4'));
    expect(() => guard.observe('review', usage('CLAUDE-SONNET-4'))).toThrow(/실제 모델이 같다/);
  });

  it('accepts distinct actual models in either execution order', () => {
    const guard = new ModelIndependenceGuard();
    guard.observe('review', usage('claude-sonnet-4'));
    expect(() => guard.observe('primary', usage('claude-opus-4'))).not.toThrow();
  });
});
