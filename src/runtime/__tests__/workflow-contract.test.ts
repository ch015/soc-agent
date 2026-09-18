import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertWorkflowPrerequisites,
  getWorkflowPhase,
  parseWorkflowContract,
} from '../contracts/workflow-contract.js';
import {
  createArtifactRef,
  parsePhaseResultEnvelope,
  verifyArtifactRef,
} from '../contracts/result-contract.js';

function contract() {
  return {
    id: 'nunchi.test.review',
    version: '1.0.0',
    domain: 'test',
    mission: 'review',
    lifecycle: 'finite' as const,
    forbiddenModelTools: ['Bash'],
    limits: { maxBudgetUsd: 3, maxIterations: 2, maxSubagentDepth: 1 },
    isolation: {
      settingSources: [],
      strictMcpConfig: true,
      disableAutoMemory: true,
      inheritParentSecrets: false,
      sandboxRequired: true,
      networkDefaultDeny: true,
      permissionMode: 'dontAsk' as const,
    },
    roles: {
      reviewer: {
        agentFile: 'contracts/roles/reviewer.md',
        description: 'review',
        tools: ['Read'],
        skills: ['review'],
        allowedDelegates: [],
        requiredCapabilities: ['structured-output', 'tool-policy'] as const,
      },
    },
    phases: [
      {
        id: 'review',
        role: 'reviewer',
        requires: [],
        controller: 'host' as const,
        strategy: 'single' as const,
        resultSchemaId: 'nunchi.test.review-result.v1',
        requiredMethodFiles: ['methods/review.md'],
        requiredArtifacts: ['review.md'],
        optionalArtifacts: [],
        approvals: [],
      },
    ],
    resources: [{ path: 'contracts/roles/reviewer.md', sha256: '0'.repeat(64) }],
  };
}

describe('common workflow contract', () => {
  it('validates identity, references, and prerequisites', () => {
    const parsed = parseWorkflowContract(contract());
    const phase = getWorkflowPhase(parsed, 'review');
    expect(() => assertWorkflowPrerequisites(phase, new Set())).not.toThrow();
  });

  it('rejects model control without bounded delegates', () => {
    const value = contract() as unknown as { phases: Array<Record<string, unknown>> };
    value.phases[0] = {
      ...value.phases[0]!,
      controller: 'in-phase-model',
      strategy: 'manager-workers',
      maxFanout: 2,
    };
    expect(() => parseWorkflowContract(value)).toThrow(/delegate/);
  });

  it('rejects phase dependency cycles', () => {
    const value = contract() as unknown as { phases: Array<Record<string, unknown>> };
    value.phases[0] = { ...value.phases[0]!, requires: ['review'] };
    expect(() => parseWorkflowContract(value)).toThrow(/cycle/);
  });

  it('rejects insecure cross-domain isolation settings', () => {
    const value = contract() as unknown as { isolation: Record<string, unknown> };
    value.isolation = { ...value.isolation, inheritParentSecrets: true };
    expect(() => parseWorkflowContract(value)).toThrow(/secure isolation baseline/);
  });
});

describe('common result contract', () => {
  it('binds artifacts by identity, size, and hash', () => {
    const engagementDir = mkdtempSync(join(tmpdir(), 'nunchi-artifact-ref-'));
    writeFileSync(join(engagementDir, 'review.md'), 'verified');
    const artifact = createArtifactRef({
      engagementDir,
      name: 'review.md',
      phase: 'review',
      role: 'reviewer',
      attempt: '1',
    });
    expect(() => verifyArtifactRef(artifact, engagementDir)).not.toThrow();
    const value = parsePhaseResultEnvelope({
      value: {
        contractId: 'nunchi.test.review',
        contractVersion: '1.0.0',
        runId: 'run-1',
        phase: 'review',
        role: 'reviewer',
        attempt: '1',
        status: 'complete',
        artifacts: [artifact],
        decisions: [],
        domainPayload: { findingCount: 0 },
        unresolved: [],
        usage: { provider: 'test', costUsd: 0 },
      },
      identity: {
        contractId: 'nunchi.test.review',
        contractVersion: '1.0.0',
        runId: 'run-1',
        phase: 'review',
        role: 'reviewer',
        attempt: '1',
      },
    });
    expect(value.artifacts[0]?.sha256).toHaveLength(64);
  });

  it('detects artifact mutation after acceptance', () => {
    const engagementDir = mkdtempSync(join(tmpdir(), 'nunchi-artifact-tamper-'));
    const path = join(engagementDir, 'review.md');
    writeFileSync(path, 'first');
    const artifact = createArtifactRef({
      engagementDir,
      name: 'review.md',
      phase: 'review',
      role: 'reviewer',
      attempt: '1',
    });
    writeFileSync(path, 'changed');
    expect(() => verifyArtifactRef(artifact, engagementDir)).toThrow(/hash|크기/);
  });
});
