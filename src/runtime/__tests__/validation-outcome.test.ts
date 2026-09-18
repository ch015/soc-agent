/**
 * M10: ValidationOutcome + validateResultV2 integration tests.
 *
 * Tests that engine.ts correctly uses the structured ValidationOutcome from validateResultV2
 * when available, falling back to validateResult when not.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseWorkflowContract } from '../contracts/workflow-contract.js';
import type { DomainAdapter, ValidationOutcome } from '../domains/domain-adapter.js';
import { ProviderRuntimeFailure, type ProviderRuntime } from '../providers/provider-runtime.js';
import { ValidationRetryError, ValidationSafetyError, WorkflowHost } from '../workflow/engine.js';
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

function fixtureWithV2(
  runtime: ProviderRuntime<undefined, Record<string, never>>,
  validateResultV2Fn: (input: { value: unknown }) => ValidationOutcome<TestResult>,
) {
  const target = mkdtempSync(join(tmpdir(), 'nunchi-v2-'));
  const engagementDir = join(target, 'reports', 'run');
  const methods = { a: join(target, 'method-a.md') };
  writeFileSync(methods.a, 'method a');
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
    // Legacy validateResult — should NOT be called when validateResultV2 is present
    validateResult: () => {
      throw new Error('legacy validateResult should not be called when validateResultV2 exists');
    },
    renderArtifacts: () => ({ required: ['a.md'], optional: [] }),
    resolveMethodFiles: () => [methods.a],
    validateResultV2: (input) => validateResultV2Fn(input),
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
    state,
    host: new WorkflowHost({ adapter, runtime, state, target, engagementDir, runId: 'run' }),
  };
}

describe('WorkflowHost M10 validateResultV2', () => {
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

  it('passes when validateResultV2 returns status:pass', async () => {
    const runtime = successRuntime();
    const run = fixtureWithV2(runtime, ({ value }) => ({
      status: 'pass',
      data: value as TestResult,
    }));

    const result = await run.host.executePhase({ id: 'a' });
    expect(result.phase).toBe('a');
    expect(result.envelope.status).toBe('complete');
  });

  it('retries when validateResultV2 returns status:retry then passes', async () => {
    const runtime = successRuntime();
    let calls = 0;
    const run = fixtureWithV2(runtime, ({ value }) => {
      calls++;
      if (calls === 1) return { status: 'retry', error: 'formatting error' };
      return { status: 'pass', data: value as TestResult };
    });

    const result = await run.host.executePhase({ id: 'a' });
    expect(result.phase).toBe('a');
    expect(calls).toBe(2);
    // Attempt 1 failed, attempt 2 completed
    const snapshot = run.state.read();
    expect(snapshot.attempts['a:-:1']?.status).toBe('failed');
    expect(snapshot.attempts['a:-:2']?.status).toBe('completed');
  });

  it('exhausts retries when validateResultV2 always returns retry', async () => {
    const runtime = successRuntime();
    let calls = 0;
    const run = fixtureWithV2(runtime, () => {
      calls++;
      return { status: 'retry', error: `retry error ${calls}` };
    });

    await expect(run.host.executePhase({ id: 'a' })).rejects.toThrow(/retry error 3/);
    expect(calls).toBe(3);
  });

  it('immediately fails on safety-fail without retry', async () => {
    const runtime = successRuntime();
    let calls = 0;
    const run = fixtureWithV2(runtime, () => {
      calls++;
      return { status: 'safety-fail', error: 'compliance violation detected' };
    });

    await expect(run.host.executePhase({ id: 'a' })).rejects.toThrow(/compliance violation detected/);
    expect(calls).toBe(1);
    // Only 1 attempt
    const snapshot = run.state.read();
    expect(snapshot.attempts['a:-:1']?.status).toBe('failed');
    expect(snapshot.attempts['a:-:2']).toBeUndefined();
  });

  it('completes with record-continue (partial result)', async () => {
    const runtime = successRuntime();
    const run = fixtureWithV2(runtime, ({ value }) => ({
      status: 'record-continue',
      data: value as TestResult,
      error: 'evidence insufficient but continuing',
      corrections: { evidenceQuality: 'low' },
    }));

    const result = await run.host.executePhase({ id: 'a' });
    expect(result.phase).toBe('a');
    expect(result.envelope.status).toBe('complete');
  });

  it('record-continue throws if data is missing', async () => {
    const runtime = successRuntime();
    const run = fixtureWithV2(runtime, () => ({
      status: 'record-continue' as const,
      error: 'some issue',
    }));

    await expect(run.host.executePhase({ id: 'a' })).rejects.toThrow(
      /record-continue에 data가 없다/,
    );
  });

  it('ValidationRetryError is always retryable via shouldRetryValidation', () => {
    const err = new ValidationRetryError('test');
    expect(err.retryable).toBe(true);
    expect(err.name).toBe('ValidationRetryError');
  });

  it('ValidationSafetyError is never retryable', () => {
    const err = new ValidationSafetyError('test');
    expect(err.safetyFail).toBe(true);
    expect(err.name).toBe('ValidationSafetyError');
  });
});
