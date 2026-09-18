import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseWorkflowContract } from '../contracts/workflow-contract.js';
import type { DomainAdapter } from '../domains/domain-adapter.js';
import { ProviderRuntimeFailure, type ProviderRuntime } from '../providers/provider-runtime.js';
import { WorkflowHost } from '../workflow/engine.js';
import { FileRunStateStore } from '../workflow/state-store.js';

type TestResult = { artifacts: string[]; status: 'complete'; unresolved: string[] };

function createContract() {
  return parseWorkflowContract({
    id: 'nunchi.test.workflow',
    version: '1.0.0',
    domain: 'test',
    mission: 'workflow',
    lifecycle: 'finite',
    forbiddenModelTools: ['Bash'],
    limits: { maxBudgetUsd: 50, maxIterations: 1, maxSubagentDepth: 0 },
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
      worker: {
        agentFile: 'roles/worker.md',
        description: 'test worker',
        tools: ['Read', 'Write'],
        skills: [],
        allowedDelegates: [],
        requiredCapabilities: [],
      },
    },
    phases: [
      {
        id: 'a',
        role: 'worker',
        requires: [],
        controller: 'host',
        strategy: 'single',
        resultSchemaId: 'test.a.v1',
        requiredMethodFiles: ['method-a.md'],
        requiredArtifacts: ['a.md'],
        optionalArtifacts: [],
        approvals: [],
      },
    ],
    resources: [{ path: 'roles/worker.md', sha256: '0'.repeat(64) }],
  });
}

function fixture(
  runtime: ProviderRuntime<undefined, Record<string, never>>,
  opts?: { validateCallCount?: number },
) {
  const target = mkdtempSync(join(tmpdir(), 'nunchi-retry-target-'));
  const engagementDir = join(target, 'reports', 'run');
  const methods = { a: join(target, 'method-a.md') };
  writeFileSync(methods.a, 'method a');
  const contract = createContract();

  let validateCalls = 0;
  const failUntil = opts?.validateCallCount ?? 0;

  const adapter: DomainAdapter<typeof contract, (typeof contract.phases)[number], TestResult> = {
    domain: 'test',
    mission: 'workflow',
    contract,
    legacyContract: contract,
    buildAgentDefinitions: () => ({}),
    outputFormat: () => ({ type: 'json_schema', schema: { type: 'object' } }),
    getPhase: (id) => {
      const phase = contract.phases.find((candidate) => candidate.id === id)!;
      return { workflow: phase, legacy: phase };
    },
    buildPrompt: ({ runId, attempt }) => `${runId}:${attempt}`,
    validateResult: ({ value }) => {
      validateCalls++;
      if (validateCalls <= failUntil) {
        throw new Error(`validation failed on call ${validateCalls}`);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('test structured output must be an object');
      }
      const candidate = value as Record<string, unknown>;
      if (!Array.isArray(candidate.artifacts)) throw new Error('test artifacts must be an array');
      return value as TestResult;
    },
    renderArtifacts: () => ({ required: ['a.md'], optional: [] }),
    resolveMethodFiles: () => [methods.a],
  };
  const state = FileRunStateStore.create({
    engagementDir,
    runId: 'run',
    contractId: contract.id,
    contractVersion: contract.version,
    domain: contract.domain,
    mission: contract.mission,
    maxBudgetUsd: 50,
  });
  return {
    target,
    engagementDir,
    methods,
    state,
    adapter,
    getValidateCalls: () => validateCalls,
    host: new WorkflowHost({ adapter, runtime, state, target, engagementDir, runId: 'run' }),
  };
}

function successRuntime(): ProviderRuntime<undefined, Record<string, never>> {
  return {
    name: 'test',
    capabilities: new Set(),
    runPhase: async (request) => {
      writeFileSync(join(request.engagementDir, 'a.md'), 'a');
      return {
        provider: 'test',
        texts: [],
        events: [{
          at: new Date(0).toISOString(),
          event: 'PreToolUse',
          tool: 'Read',
          resource: join(request.target, 'method-a.md'),
          decision: 'allow',
        }],
        structuredOutput: { artifacts: ['a.md'], status: 'complete', unresolved: [] },
        usage: { provider: 'test', costUsd: 0.1 },
        raw: {},
      };
    },
  };
}

describe('WorkflowHost M6a validation retry', () => {
  const originalEnv = process.env.NUNCHI_RETRY_ENABLED;

  beforeEach(() => {
    delete process.env.NUNCHI_RETRY_ENABLED;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.NUNCHI_RETRY_ENABLED = originalEnv;
    } else {
      delete process.env.NUNCHI_RETRY_ENABLED;
    }
  });

  it('retries validation failure and succeeds on 2nd attempt', async () => {
    const runtime = successRuntime();
    // Fail validation on 1st call, succeed on 2nd
    const run = fixture(runtime, { validateCallCount: 1 });

    const result = await run.host.executePhase({ id: 'a' });
    expect(result.phase).toBe('a');
    expect(result.envelope.status).toBe('complete');
    expect(run.getValidateCalls()).toBe(2);

    // Verify that attempt 1 was marked failed and attempt 2 completed
    const snapshot = run.state.read();
    expect(snapshot.attempts['a:-:1']?.status).toBe('failed');
    expect(snapshot.attempts['a:-:2']?.status).toBe('completed');
  });

  it('fails after exhausting all 3 retry attempts', async () => {
    const runtime = successRuntime();
    // Fail validation on all 3 calls
    const run = fixture(runtime, { validateCallCount: 10 });

    await expect(run.host.executePhase({ id: 'a' })).rejects.toThrow(/validation failed on call 3/);
    expect(run.getValidateCalls()).toBe(3);

    // All 3 attempts should be failed
    const snapshot = run.state.read();
    expect(snapshot.attempts['a:-:1']?.status).toBe('failed');
    expect(snapshot.attempts['a:-:2']?.status).toBe('failed');
    expect(snapshot.attempts['a:-:3']?.status).toBe('failed');
  });

  it('does NOT retry ProviderRuntimeFailure', async () => {
    let calls = 0;
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test',
      capabilities: new Set(),
      runPhase: async () => {
        calls++;
        throw new ProviderRuntimeFailure('sdk network error', {
          provider: 'test',
          costUsd: 0.1,
          accountingComplete: true,
        });
      },
    };
    const run = fixture(runtime);

    await expect(run.host.executePhase({ id: 'a' })).rejects.toThrow(/sdk network error/);
    expect(calls).toBe(1);
    expect(run.state.read().attempts['a:-:1']?.status).toBe('failed');
  });

  it('does NOT retry when NUNCHI_RETRY_ENABLED=false', async () => {
    process.env.NUNCHI_RETRY_ENABLED = 'false';
    const runtime = successRuntime();
    // Would succeed on 2nd call but retry is disabled
    const run = fixture(runtime, { validateCallCount: 1 });

    await expect(run.host.executePhase({ id: 'a' })).rejects.toThrow(/validation failed on call 1/);
    expect(run.getValidateCalls()).toBe(1);
    expect(run.state.read().attempts['a:-:1']?.status).toBe('failed');
  });

  it('includes previous error message in retry prompt context', async () => {
    const prompts: string[] = [];
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test',
      capabilities: new Set(),
      runPhase: async (request) => {
        prompts.push(request.prompt);
        writeFileSync(join(request.engagementDir, 'a.md'), 'a');
        return {
          provider: 'test',
          texts: [],
          events: [{
            at: new Date(0).toISOString(),
            event: 'PreToolUse',
            tool: 'Read',
            resource: join(request.target, 'method-a.md'),
            decision: 'allow',
          }],
          structuredOutput: { artifacts: ['a.md'], status: 'complete', unresolved: [] },
          usage: { provider: 'test', costUsd: 0.1 },
          raw: {},
        };
      },
    };
    // Fail first validation, succeed on 2nd
    const run = fixture(runtime, { validateCallCount: 1 });

    await run.host.executePhase({ id: 'a' });

    // First prompt should NOT have retry context
    expect(prompts[0]).not.toContain('Retry context');
    // Second prompt should include the validation error (sanitized, no [SYSTEM: tag)
    expect(prompts[1]).toContain('--- Retry context (attempt 1) ---');
    expect(prompts[1]).toContain('validation failed on call 1');
    expect(prompts[1]).not.toContain('[SYSTEM:');
  });

  it('does NOT retry host integrity errors (assertHostResourceReceipts)', async () => {
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test',
      capabilities: new Set(),
      runPhase: async (request) => {
        // Mutate method file during execution to trigger host resource hash failure
        writeFileSync(join(request.target, 'method-a.md'), 'mutated content');
        writeFileSync(join(request.engagementDir, 'a.md'), 'a');
        return {
          provider: 'test',
          texts: [],
          events: [],
          structuredOutput: { artifacts: ['a.md'], status: 'complete', unresolved: [] },
          usage: { provider: 'test', costUsd: 0.1 },
          raw: {},
        };
      },
    };
    const target = mkdtempSync(join(tmpdir(), 'nunchi-retry-integrity-'));
    const engagementDir = join(target, 'reports', 'run');
    const methodPath = join(target, 'method-a.md');
    writeFileSync(methodPath, 'method a');
    const contract = createContract();
    const adapter: DomainAdapter<typeof contract, (typeof contract.phases)[number], TestResult> = {
      domain: 'test',
      mission: 'workflow',
      contract,
      legacyContract: contract,
      buildAgentDefinitions: () => ({}),
      outputFormat: () => ({ type: 'json_schema', schema: { type: 'object' } }),
      getPhase: (id) => {
        const phase = contract.phases.find((c) => c.id === id)!;
        return { workflow: phase, legacy: phase };
      },
      buildPrompt: () => 'prompt',
      validateResult: ({ value }) => value as TestResult,
      renderArtifacts: () => ({ required: ['a.md'], optional: [] }),
      resolveMethodFiles: () => [methodPath],
      hostPromptResources: () => [methodPath],
    };
    const state = FileRunStateStore.create({
      engagementDir,
      runId: 'run',
      contractId: contract.id,
      contractVersion: contract.version,
      domain: contract.domain,
      mission: contract.mission,
      maxBudgetUsd: 50,
    });
    const host = new WorkflowHost({ adapter, runtime, state, target, engagementDir, runId: 'run' });

    await expect(host.executePhase({ id: 'a' })).rejects.toThrow(/host contract resource hash/);
    // Should only have 1 attempt — no retry for integrity errors
    expect(state.read().attempts['a:-:1']?.status).toBe('failed');
    expect(state.read().attempts['a:-:2']).toBeUndefined();
  });
});
