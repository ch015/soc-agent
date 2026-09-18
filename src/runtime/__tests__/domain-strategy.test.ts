import { describe, expect, it } from 'vitest';

import { parseWorkflowContract, type WorkflowContract } from '../contracts/workflow-contract.js';
import type { DomainAdapter } from '../domains/domain-adapter.js';
import { DomainRegistry } from '../domains/registry.js';
import { assertStrategyExecutable, assertStrategySupported } from '../workflow/strategies.js';

function contract(domain: 'soc' | 'feedback', strategy: 'single' | 'parallel' = 'single') {
  return parseWorkflowContract({
    id: `nunchi.${domain}.review`,
    version: '1.0.0',
    domain,
    mission: 'review',
    lifecycle: domain === 'soc' ? 'event-triggered' : 'finite',
    forbiddenModelTools: ['Bash'],
    limits: { maxBudgetUsd: 5, maxIterations: 2, maxSubagentDepth: 0 },
    isolation: {
      settingSources: [],
      strictMcpConfig: true,
      disableAutoMemory: true,
      inheritParentSecrets: false,
      sandboxRequired: true,
      networkDefaultDeny: true,
      permissionMode: 'dontAsk',
    },
    roles: {
      reviewer: {
        agentFile: 'contracts/roles/reviewer.md',
        description: 'domain review',
        tools: ['Read'],
        skills: ['review'],
        allowedDelegates: [],
        requiredCapabilities: ['structured-output', 'tool-policy'],
      },
    },
    phases: [
      {
        id: 'review',
        role: 'reviewer',
        requires: [],
        controller: 'host',
        strategy,
        resultSchemaId: `nunchi.${domain}.review-result.v1`,
        requiredMethodFiles: ['methods/review.md'],
        requiredArtifacts: ['review.json'],
        optionalArtifacts: [],
        approvals: [],
        ...(strategy === 'parallel' ? { maxFanout: 2 } : {}),
      },
    ],
    resources: [{ path: 'contracts/roles/reviewer.md', sha256: '0'.repeat(64) }],
  });
}

function adapter(domainContract: WorkflowContract): DomainAdapter {
  return {
    domain: domainContract.domain,
    mission: domainContract.mission,
    contract: domainContract,
    legacyContract: {},
    buildAgentDefinitions: () => ({}),
    outputFormat: () => ({ type: 'json_schema', schema: { type: 'object' } }),
    getPhase: () => ({ workflow: domainContract.phases[0]!, legacy: {} }),
    buildPrompt: () => 'review',
    validateResult: (input) => input.value,
    renderArtifacts: () => ({ required: ['review.json'], optional: [] }),
    resolveMethodFiles: () => ['/methods/review.md'],
  };
}

describe('cross-domain registration surface', () => {
  it('registers SOC and Feedback without OffSec fields in the common core', () => {
    const registry = new DomainRegistry();
    for (const domain of ['soc', 'feedback'] as const) {
      const value = contract(domain);
      registry.register(domain, 'review', () => adapter(value));
    }
    expect(registry.list()).toEqual(['feedback/review', 'soc/review']);
    expect(registry.get('soc').contract.lifecycle).toBe('event-triggered');
    expect(registry.get('feedback').contract.publication).toBeUndefined();
  });

  it('rejects registration identity drift', () => {
    const registry = new DomainRegistry();
    registry.register('soc', 'review', () => adapter(contract('feedback')));
    expect(() => registry.get('soc')).toThrow(/identity/);
  });
});

describe('bounded execution strategy surface', () => {
  it('derives host-owned bounds and provider requirements', () => {
    const value = contract('soc', 'parallel');
    const runtime = {
      name: 'test',
      capabilities: new Set(['structured-output', 'tool-policy', 'parallel-workers'] as const),
    };
    const plan = assertStrategySupported(value, value.phases[0]!, runtime);
    expect(plan).toMatchObject({
      outerController: 'host',
      inPhaseCoordinator: 'host',
      maxFanout: 2,
      maxProviderCalls: 3,
    });
    expect(() => assertStrategyExecutable(value.phases[0]!)).toThrow(/아직 등록되지 않았다/);
  });

  it('fails closed when a provider cannot enforce a strategy capability', () => {
    const value = contract('soc', 'parallel');
    expect(() =>
      assertStrategySupported(value, value.phases[0]!, {
        name: 'limited',
        capabilities: new Set(),
      }),
    ).toThrow(/parallel-workers/);
  });
});
