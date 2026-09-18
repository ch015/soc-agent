import type { ProviderUsage } from '../contracts/result-contract.js';
import type { RunSnapshot } from './state-store.js';

export type ModelPurpose = 'primary' | 'review';

/** Enforces model diversity from provider-verified identities, not requested aliases. */
export class ModelIndependenceGuard {
  private readonly primary = new Set<string>();
  private readonly review = new Set<string>();

  static fromSnapshot(
    snapshot: Readonly<RunSnapshot>,
    purposeForPhase: (phase: string) => ModelPurpose,
  ): ModelIndependenceGuard {
    const guard = new ModelIndependenceGuard();
    for (const attempt of Object.values(snapshot.attempts)) {
      if (attempt.usage) guard.observe(purposeForPhase(attempt.phase), attempt.usage);
    }
    return guard;
  }

  observe(purpose: ModelPurpose, usage: ProviderUsage): void {
    if (usage.modelIdentityVerified !== true || !usage.model) {
      throw new Error(`${purpose} phase에 provider-verified actual model identity가 없다`);
    }
    const canonicalModel = usage.model.toLowerCase();
    const own = purpose === 'primary' ? this.primary : this.review;
    const opposite = purpose === 'primary' ? this.review : this.primary;
    if (opposite.has(canonicalModel)) {
      throw new Error(`primary와 review phase의 실제 모델이 같다: ${usage.model}`);
    }
    own.add(canonicalModel);
  }
}
