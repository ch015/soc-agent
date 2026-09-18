import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseWorkflowContract } from '../contracts/workflow-contract.js';
import type { DomainAdapter } from '../domains/domain-adapter.js';
import { ProviderRuntimeFailure, type ProviderRuntime } from '../providers/provider-runtime.js';
import { WorkflowHost } from '../workflow/engine.js';
import { FileRunStateStore } from '../workflow/state-store.js';

type TestResult = { artifacts: string[]; status: 'complete'; unresolved: string[] };

function fixture(
  runtime: ProviderRuntime<undefined, Record<string, never>>,
  withHostResources = false,
  leaseGuard?: { assertActive(): Promise<void> },
) {
  const target = mkdtempSync(join(tmpdir(), 'nunchi-engine-target-'));
  const engagementDir = join(target, 'reports', 'run');
  const methods = { a: join(target, 'method-a.md'), b: join(target, 'method-b.md') };
  writeFileSync(methods.a, 'method a');
  writeFileSync(methods.b, 'method b');
  const contract = parseWorkflowContract({
    id: 'nunchi.test.workflow',
    version: '1.0.0',
    domain: 'test',
    mission: 'workflow',
    lifecycle: 'finite',
    forbiddenModelTools: ['Bash'],
    limits: { maxBudgetUsd: 5, maxIterations: 1, maxSubagentDepth: 0 },
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
      {
        id: 'b',
        role: 'worker',
        requires: ['a'],
        controller: 'host',
        strategy: 'single',
        resultSchemaId: 'test.b.v1',
        requiredMethodFiles: ['method-b.md'],
        requiredArtifacts: ['b.md'],
        optionalArtifacts: [],
        approvals: [],
      },
    ],
    resources: [{ path: 'roles/worker.md', sha256: '0'.repeat(64) }],
  });
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
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('test structured output must be an object');
      }
      const candidate = value as Record<string, unknown>;
      if (!Array.isArray(candidate.artifacts)) throw new Error('test artifacts must be an array');
      if (candidate.status !== 'complete' && candidate.status !== 'blocked') {
        throw new Error('test status is invalid');
      }
      if (!Array.isArray(candidate.unresolved)) throw new Error('test unresolved must be an array');
      return value as TestResult;
    },
    renderArtifacts: (phase) => ({ required: [`${phase.id}.md`], optional: [] }),
    resolveMethodFiles: (phase) => [methods[phase.id as 'a' | 'b']],
    ...(withHostResources ? { hostPromptResources: () => [methods.a, methods.b] } : {}),
  };
  const state = FileRunStateStore.create({
    engagementDir,
    runId: 'run',
    contractId: contract.id,
    contractVersion: contract.version,
    domain: contract.domain,
    mission: contract.mission,
    maxBudgetUsd: 5,
  });
  return {
    target,
    engagementDir,
    methods,
    state,
    host: new WorkflowHost({ adapter, runtime, state, target, engagementDir, runId: 'run', ...(leaseGuard ? { leaseGuard } : {}) }),
  };
}

describe('WorkflowHost integrity and recovery', () => {
  it('rejects mutated prior artifacts before calling the next phase provider', async () => {
    const calls: string[] = [];
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test',
      capabilities: new Set(),
      runPhase: async (request) => {
        calls.push(request.phase);
        writeFileSync(join(request.engagementDir, `${request.phase}.md`), request.phase);
        return {
          provider: 'test',
          texts: [],
          events: [
            {
              at: new Date(0).toISOString(),
              event: 'PreToolUse',
              tool: 'Read',
              resource: join(request.target, `method-${request.phase}.md`),
              decision: 'allow',
            },
          ],
          structuredOutput: { artifacts: [`${request.phase}.md`], status: 'complete', unresolved: [] },
          usage: { provider: 'test', costUsd: 0.1 },
          raw: {},
        };
      },
    };
    const run = fixture(runtime);
    const first = await run.host.executePhase({ id: 'a' });
    expect(first.envelope.runId).toBe('run');
    writeFileSync(join(run.engagementDir, 'a.md'), 'mutated');
    await expect(run.host.executePhase({ id: 'b' })).rejects.toThrow(/hash|크기/);
    expect(calls).toEqual(['a']);
  });

  it('does not automatically rerun an incomplete attempt', async () => {
    let calls = 0;
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test',
      capabilities: new Set(),
      runPhase: async () => {
        calls += 1;
        throw new Error('must not run');
      },
    };
    const run = fixture(runtime);
    run.state.append({ type: 'phase.started', eventId: 'a:start', phase: 'a', attempt: 1 });
    await expect(run.host.executePhase({ id: 'a' })).rejects.toThrow(/자동 재실행할 수 없다/);
    expect(calls).toBe(0);
  });

  it('does not commit a provider receipt after an external lease guard is lost', async () => {
    let checks = 0;
    const leaseGuard = {
      assertActive: async () => {
        checks += 1;
        if (checks >= 3) throw new Error('lease lost');
      },
    };
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test',
      capabilities: new Set(),
      runPhase: async (request) => {
        writeFileSync(join(request.engagementDir, 'a.md'), 'a');
        return {
          provider: 'test', texts: [], events: [{
            at: new Date(0).toISOString(), event: 'PreToolUse', tool: 'Read',
            resource: join(request.target, 'method-a.md'), decision: 'allow',
          }],
          structuredOutput: { artifacts: ['a.md'], status: 'complete', unresolved: [] },
          usage: { provider: 'test', costUsd: 0.1 }, raw: {},
        };
      },
    };
    const run = fixture(runtime, false, leaseGuard);
    await expect(run.host.executePhase({ id: 'a' })).rejects.toThrow(/lease lost/);
    expect(run.state.read().attempts['a:-:1']?.status).toBe('started');
    expect(run.state.read().totalCostUsd).toBe(0);
  });

  it('blocks completion when an injected host resource changes during provider execution', async () => {
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test',
      capabilities: new Set(),
      runPhase: async (request) => {
        writeFileSync(join(request.target, 'method-a.md'), 'method a changed during execution');
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
    const run = fixture(runtime, true);
    await expect(run.host.executePhase({ id: 'a' })).rejects.toThrow(/host contract resource hash/);
    expect(run.state.read().attempts['a:-:1']?.status).toBe('failed');
  });

  it('charges usage attached to a provider failure before failing the attempt', async () => {
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test',
      capabilities: new Set(),
      runPhase: async () => {
        throw new ProviderRuntimeFailure('stream failed', {
          provider: 'test',
          costUsd: 1.5,
          accountingComplete: false,
        }, undefined, [{
          at: new Date(0).toISOString(),
          event: 'compact_boundary',
          compaction: {
            trigger: 'auto', preTokens: 900, postTokens: 200,
            boundaryId: 'boundary-failure',
          },
        }]);
      },
    };
    const run = fixture(runtime);
    await expect(run.host.executePhase({ id: 'a' })).rejects.toThrow(/stream failed/);
    expect(run.state.read().totalCostUsd).toBe(1.5);
    expect(run.state.read().attempts['a:-:1']?.status).toBe('failed');
    // accounting 불완전은 이제 run.blocked를 발행하지 않음 (warning-only)
    expect(run.state.read().status).toBe('running');
    const eventTypes = readFileSync(join(run.engagementDir, 'run-events.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    expect(eventTypes.map((event) => event.type)).toEqual([
      'run.created', 'phase.started', 'phase.context-compacted',
      'attempt.received', 'phase.failed',
    ]);
  });

  it('defers run blocking for a wave worker while preserving its failed attempt receipt', async () => {
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test',
      capabilities: new Set(),
      runPhase: async () => {
        throw new ProviderRuntimeFailure('wave stream failed', {
          provider: 'test', costUsd: 0.5, accountingComplete: false,
        });
      },
    };
    const run = fixture(runtime);
    await expect(run.host.executePhase({ id: 'a', round: 'unit-a', deferRunBlocking: true }))
      .rejects.toThrow(/wave stream failed/);
    expect(run.state.read().attempts['a:unit-a:1']?.status).toBe('failed');
    expect(run.state.read().status).toBe('running');
  });

  it('allows the host to suppress unrelated completed artifacts from a worker context', async () => {
    const observed: Record<string, readonly string[] | undefined> = {};
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test',
      capabilities: new Set(),
      runPhase: async (request) => {
        observed[request.phase] = request.allowedReadFiles;
        writeFileSync(join(request.engagementDir, `${request.phase}.md`), request.phase);
        return {
          provider: 'test', texts: [], events: [{
            at: new Date(0).toISOString(), event: 'PreToolUse', tool: 'Read',
            resource: join(request.target, `method-${request.phase}.md`), decision: 'allow',
          }],
          structuredOutput: { artifacts: [`${request.phase}.md`], status: 'complete', unresolved: [] },
          usage: { provider: 'test', costUsd: 0.1 }, raw: {},
        };
      },
    };
    const run = fixture(runtime);
    await run.host.executePhase({ id: 'a' });
    await run.host.executePhase({ id: 'b', priorArtifactPaths: [] });
    expect(observed.b ?? []).not.toContain(join(run.engagementDir, 'a.md'));
  });

  it('does not complete a blocked result or open downstream prerequisites', async () => {
    const calls: string[] = [];
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test',
      capabilities: new Set(),
      runPhase: async (request) => {
        calls.push(request.phase);
        writeFileSync(join(request.engagementDir, `${request.phase}.md`), request.phase);
        return {
          provider: 'test',
          texts: [],
          events: [
            {
              at: new Date(0).toISOString(),
              event: 'PreToolUse',
              tool: 'Read',
              resource: join(request.target, `method-${request.phase}.md`),
              decision: 'allow',
            },
          ],
          structuredOutput: {
            artifacts: [`${request.phase}.md`],
            status: 'blocked',
            unresolved: ['manual decision required'],
          },
          usage: { provider: 'test', costUsd: 0.1 },
          raw: {},
        };
      },
    };
    const run = fixture(runtime);
    await expect(run.host.executePhase({ id: 'a' })).rejects.toThrow(/blocked 상태/);
    expect(run.state.read().completedPhases).toEqual([]);
    expect(run.state.read().attempts['a:-:1']?.status).toBe('failed');
    await expect(run.host.executePhase({ id: 'b' })).rejects.toThrow(/선행 계약/);
    expect(calls).toEqual(['a']);
  });

  it.each([
    ['absent', undefined, 'absent'],
    ['exact', {
      workUnitKey: 'unit-0000000000000001',
      workPlanSha256: 'a'.repeat(64),
      assignedSourceSha256: 'b'.repeat(64),
    }, 'matched'],
    ['wrong', {
      workUnitKey: 'unit-0000000000000002',
      workPlanSha256: 'c'.repeat(64),
      assignedSourceSha256: 'd'.repeat(64),
    }, 'overridden'],
    ['malformed', 'provider-text', 'overridden'],
  ])('host-binds %s provider identity before validation', async (_label, providerIdentity, disposition) => {
    const expected = {
      workUnitKey: 'unit-0000000000000001',
      workPlanSha256: 'a'.repeat(64),
      assignedSourceSha256: 'b'.repeat(64),
    };
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test',
      capabilities: new Set(),
      runPhase: async (request) => {
        writeFileSync(join(request.engagementDir, 'a.md'), 'a');
        return {
          provider: 'test', texts: [], events: [{
            at: new Date(0).toISOString(), event: 'PreToolUse', tool: 'Read',
            resource: join(request.target, 'method-a.md'), decision: 'allow',
          }],
          structuredOutput: {
            artifacts: ['a.md'], status: 'complete', unresolved: [],
            ...(providerIdentity === undefined ? {} : { workUnit: providerIdentity }),
          },
          usage: { provider: 'test', costUsd: 0.1 }, raw: {},
        };
      },
    };
    const run = fixture(runtime);
    const execution = await run.host.executePhase({ id: 'a', resultIdentity: expected });
    expect((execution.result as TestResult & { workUnit: unknown }).workUnit).toEqual(expected);
    const events = readFileSync(join(run.engagementDir, 'run-events.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as { type: string; providerIdentity?: string });
    expect(events.map((event) => event.type)).toContain('phase.result-identity-bound');
    expect(events.find((event) => event.type === 'phase.result-identity-bound')?.providerIdentity)
      .toBe(disposition);
  });

  it('keeps root phases unchanged and rejects non-object provider output', async () => {
    const identity = {
      workUnitKey: 'unit-0000000000000001',
      workPlanSha256: 'a'.repeat(64),
      assignedSourceSha256: 'b'.repeat(64),
    };
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test', capabilities: new Set(),
      runPhase: async (request) => {
        writeFileSync(join(request.engagementDir, 'a.md'), 'a');
        return {
          provider: 'test', texts: [], events: [{
            at: new Date(0).toISOString(), event: 'PreToolUse', tool: 'Read',
            resource: join(request.target, 'method-a.md'), decision: 'allow',
          }],
          structuredOutput: [], usage: { provider: 'test', costUsd: 0.1 }, raw: {},
        };
      },
    };
    const run = fixture(runtime);
    await expect(run.host.executePhase({ id: 'a', resultIdentity: identity })).rejects
      .toThrow(/plain object/);
    const events = readFileSync(join(run.engagementDir, 'run-events.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    expect(events.some((event) => event.type === 'phase.result-identity-bound')).toBe(false);
    expect(events.at(-1)?.type).toBe('phase.failed');

    const rootRuntime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test', capabilities: new Set(),
      runPhase: async (request) => {
        writeFileSync(join(request.engagementDir, 'a.md'), 'a');
        return {
          provider: 'test', texts: [], events: [{
            at: new Date(0).toISOString(), event: 'PreToolUse', tool: 'Read',
            resource: join(request.target, 'method-a.md'), decision: 'allow',
          }],
          structuredOutput: { artifacts: ['a.md'], status: 'complete', unresolved: [] },
          usage: { provider: 'test', costUsd: 0.1 }, raw: {},
        };
      },
    };
    const rootRun = fixture(rootRuntime);
    const rootExecution = await rootRun.host.executePhase({ id: 'a' });
    expect((rootExecution.result as TestResult & { workUnit?: unknown }).workUnit).toBeUndefined();
    const rootEvents = readFileSync(join(rootRun.engagementDir, 'run-events.jsonl'), 'utf8');
    expect(rootEvents).not.toContain('phase.result-identity-bound');
  });
});


describe('retry action budget', () => {
  it('charges failed validation attempts before permitting another model call', async () => {
    const budgets: Array<number | undefined> = [];
    const runtime: ProviderRuntime<undefined, Record<string, never>> = {
      name: 'test', capabilities: new Set(),
      async runPhase(request) {
        budgets.push(request.maxBudgetUsd);
        return { provider: 'test', texts: [], events: [], structuredOutput: null,
          usage: { provider: 'test', costUsd: budgets.length === 1 ? 3 : 2, accountingComplete: true }, raw: {} };
      },
    };
    const { host, state } = fixture(runtime, true);
    await expect(host.executePhase({ id: 'a' })).rejects.toThrow(/예산/);
    expect(budgets).toEqual([5, 2]);
    expect(state.read().totalCostUsd).toBe(5);
    expect(state.read().status).toBe('blocked');
  });
});
