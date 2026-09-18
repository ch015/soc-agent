import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getDomainAdapter, registeredDomainAdapters } from '../domains/registry.js';
import { AnthropicAgentRuntime } from '../providers/anthropic-agent-sdk.js';
import { assertProviderCapabilities, ProviderRuntimeFailure } from '../providers/provider-runtime.js';
import type { LedgerRow, SessionOutcome, SessionSpec } from '../session.js';

describe('domain adapter registry', () => {
  it('registers only SOC missions', () => {
    expect(registeredDomainAdapters()).toEqual(['soc/investigation', 'soc/report']);
    expect(() => getDomainAdapter('offsec')).toThrow(/등록되지 않았다/);
    expect(() => getDomainAdapter('feedback')).toThrow(/등록되지 않았다/);
  });
  it('requires mission for a multi-mission domain and resolves exact SOC contracts', () => {
    expect(() => getDomainAdapter('soc')).toThrow(/모호/);
    expect(getDomainAdapter('soc', 'report').contract.id).toBe('nunchi.soc.report');
    expect(getDomainAdapter('soc', 'investigation').contract.id).toBe('nunchi.soc.investigation');
    expect(() => getDomainAdapter('soc', 'response')).toThrow(/등록되지 않았다/);
  });
});

describe('Anthropic provider adapter', () => {
  it('rejects capabilities the current SDK adapter cannot guarantee', () => {
    const runtime = new AnthropicAgentRuntime(async () => ({ texts: [], ledger: [] }));
    expect(() => assertProviderCapabilities(runtime, ['resume'])).toThrow(/resume/);
  });

  it('normalizes usage and host ledger events', async () => {
    const target = mkdtempSync(join(tmpdir(), 'nunchi-provider-'));
    writeFileSync(join(target, 'source.ts'), 'export {};');
    const adapter = getDomainAdapter('soc', 'report');
    const phase = adapter.getPhase('evidence-review');
    const runner = async (_spec: SessionSpec): Promise<SessionOutcome> => ({
      texts: ['ok'],
      ledger: [],
      numTurns: 2,
      totalCostUsd: 0.5,
      modelUsage: { input_tokens: 10 },
      structuredOutput: { status: 'complete' },
    });
    const runtime = new AnthropicAgentRuntime(runner);
    const outcome = await runtime.runPhase({
      contractId: adapter.contract.id,
      contractVersion: adapter.contract.version,
      domain: adapter.domain,
      mission: adapter.mission,
      phase: phase.workflow.id,
      role: phase.workflow.role,
      runId: 'run-1',
      attempt: '1',
      target,
      engagementDir: join(target, 'reports', 'run-1'),
      prompt: 'test',
      requiredCapabilities: adapter.contract.roles[phase.workflow.role]!.requiredCapabilities,
      maxBudgetUsd: 1,
    });
    expect(outcome.usage).toMatchObject({ provider: 'anthropic-agent-sdk', turns: 2, costUsd: 0.5 });
    expect(outcome.structuredOutput).toEqual({ status: 'complete' });
  });

  it('normalizes compact boundary metadata and preserves it on provider failures', async () => {
    const target = mkdtempSync(join(tmpdir(), 'nunchi-provider-compact-'));
    const adapter = getDomainAdapter('soc', 'report');
    const phase = adapter.getPhase('evidence-review');
    const compact: LedgerRow = {
      at: new Date(0).toISOString(),
      event: 'compact_boundary',
      compaction: {
        trigger: 'auto',
        preTokens: 1200,
        postTokens: 300,
        durationMs: 15,
        boundaryId: 'boundary-1',
      },
    };
    const success = new AnthropicAgentRuntime(async () => ({
      texts: [], ledger: [compact], totalCostUsd: 0.1,
      modelUsage: { 'claude-opus-4-6': { inputTokens: 1 } }, structuredOutput: {},
    }));
    const successOutcome = await success.runPhase({
      contractId: adapter.contract.id, contractVersion: adapter.contract.version,
      domain: adapter.domain, mission: adapter.mission, phase: phase.workflow.id,
      role: phase.workflow.role, runId: 'run-compact-success', attempt: 'va:-:1', target,
      engagementDir: join(target, 'reports', 'run-compact-success'), prompt: 'test',
      requiredCapabilities: adapter.contract.roles[phase.workflow.role]!.requiredCapabilities,
      options: { model: 'claude-opus-4-6' },
    });
    expect(successOutcome.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'compact_boundary',
        compaction: expect.objectContaining({ boundaryId: 'boundary-1', preTokens: 1200 }),
      }),
    ]));

    let failure: ProviderRuntimeFailure | undefined;
    const failed = new AnthropicAgentRuntime(async (spec) => {
      spec.onLedger?.(compact);
      throw new Error('stream reset after compaction');
    });
    try {
      await failed.runPhase({
        contractId: adapter.contract.id, contractVersion: adapter.contract.version,
        domain: adapter.domain, mission: adapter.mission, phase: phase.workflow.id,
        role: phase.workflow.role, runId: 'run-compact-failure', attempt: 'va:-:1', target,
        engagementDir: join(target, 'reports', 'run-compact-failure'), prompt: 'test',
        requiredCapabilities: adapter.contract.roles[phase.workflow.role]!.requiredCapabilities,
      });
    } catch (error) {
      failure = error as ProviderRuntimeFailure;
    }
    expect(failure).toBeInstanceOf(ProviderRuntimeFailure);
    expect(failure?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ compaction: expect.objectContaining({ boundaryId: 'boundary-1' }) }),
    ]));
  });

  it('rejects a provider model receipt that does not match the requested model', async () => {
    const target = mkdtempSync(join(tmpdir(), 'nunchi-provider-model-'));
    const adapter = getDomainAdapter('soc', 'report');
    const phase = adapter.getPhase('evidence-review');
    const runtime = new AnthropicAgentRuntime(async () => ({
      texts: [], ledger: [], totalCostUsd: 0.1,
      modelUsage: { 'actual-reviewer-model': { inputTokens: 1 } },
      structuredOutput: {},
    }));
    await expect(runtime.runPhase({
      contractId: adapter.contract.id,
      contractVersion: adapter.contract.version,
      domain: adapter.domain,
      mission: adapter.mission,
      phase: phase.workflow.id,
      role: phase.workflow.role,
      runId: 'run-model-mismatch',
      attempt: '1',
      target,
      engagementDir: join(target, 'reports', 'run-model-mismatch'),
      prompt: 'test',
      requiredCapabilities: adapter.contract.roles[phase.workflow.role]!.requiredCapabilities,
      options: { model: 'requested-primary-model' },
    })).rejects.toThrow(/model identity/);
  });

  it('rejects model names that only contain the requested family as a substring', async () => {
    const target = mkdtempSync(join(tmpdir(), 'nunchi-provider-model-lookalike-'));
    const adapter = getDomainAdapter('soc', 'report');
    const phase = adapter.getPhase('evidence-review');
    const runtime = new AnthropicAgentRuntime(async () => ({
      texts: [], ledger: [], totalCostUsd: 0.1,
      modelUsage: { 'not-sonnet-compatible': { inputTokens: 1 } },
      structuredOutput: {},
    }));
    await expect(runtime.runPhase({
      contractId: adapter.contract.id,
      contractVersion: adapter.contract.version,
      domain: adapter.domain,
      mission: adapter.mission,
      phase: phase.workflow.id,
      role: phase.workflow.role,
      runId: 'run-model-lookalike',
      attempt: '1',
      target,
      engagementDir: join(target, 'reports', 'run-model-lookalike'),
      prompt: 'test',
      requiredCapabilities: adapter.contract.roles[phase.workflow.role]!.requiredCapabilities,
      options: { model: 'sonnet' },
    })).rejects.toThrow(/model identity/);
  });

  it('accepts a concrete Claude model receipt for a requested family alias', async () => {
    const target = mkdtempSync(join(tmpdir(), 'nunchi-provider-model-family-'));
    const adapter = getDomainAdapter('soc', 'report');
    const phase = adapter.getPhase('evidence-review');
    const runtime = new AnthropicAgentRuntime(async () => ({
      texts: [], ledger: [], totalCostUsd: 0.1,
      modelUsage: { 'claude-sonnet-4-5-20250929': { inputTokens: 1 } },
      structuredOutput: {},
    }));
    const outcome = await runtime.runPhase({
      contractId: adapter.contract.id,
      contractVersion: adapter.contract.version,
      domain: adapter.domain,
      mission: adapter.mission,
      phase: phase.workflow.id,
      role: phase.workflow.role,
      runId: 'run-model-family',
      attempt: '1',
      target,
      engagementDir: join(target, 'reports', 'run-model-family'),
      prompt: 'test',
      requiredCapabilities: adapter.contract.roles[phase.workflow.role]!.requiredCapabilities,
      options: { model: 'sonnet' },
    });
    expect(outcome.usage).toMatchObject({
      model: 'claude-sonnet-4-5-20250929',
      modelIdentityVerified: true,
    });
  });

  it('does not append another date to an already dated requested model id', async () => {
    const target = mkdtempSync(join(tmpdir(), 'nunchi-provider-model-double-date-'));
    const adapter = getDomainAdapter('soc', 'report');
    const phase = adapter.getPhase('evidence-review');
    const runtime = new AnthropicAgentRuntime(async () => ({
      texts: [], ledger: [], totalCostUsd: 0.1,
      modelUsage: { 'claude-sonnet-4-5-20250929-20260101': { inputTokens: 1 } },
      structuredOutput: {},
    }));
    await expect(runtime.runPhase({
      contractId: adapter.contract.id,
      contractVersion: adapter.contract.version,
      domain: adapter.domain,
      mission: adapter.mission,
      phase: phase.workflow.id,
      role: phase.workflow.role,
      runId: 'run-model-double-date',
      attempt: '1',
      target,
      engagementDir: join(target, 'reports', 'run-model-double-date'),
      prompt: 'test',
      requiredCapabilities: adapter.contract.roles[phase.workflow.role]!.requiredCapabilities,
      options: { model: 'claude-sonnet-4-5-20250929' },
    })).rejects.toThrow(/model identity/);
  });

  it('marks Anthropic stream failures as accounting-incomplete usage failures', async () => {
    const target = mkdtempSync(join(tmpdir(), 'nunchi-provider-failure-'));
    const adapter = getDomainAdapter('soc', 'report');
    const phase = adapter.getPhase('evidence-review');
    const runtime = new AnthropicAgentRuntime(async () => {
      throw new Error('stream reset');
    });
    try {
      await runtime.runPhase({
        contractId: adapter.contract.id,
        contractVersion: adapter.contract.version,
        domain: adapter.domain,
        mission: adapter.mission,
        phase: phase.workflow.id,
        role: phase.workflow.role,
        runId: 'run-failure',
        attempt: 'va:-:1',
        target,
        engagementDir: join(target, 'reports', 'run-failure'),
        prompt: 'test',
        requiredCapabilities: adapter.contract.roles[phase.workflow.role]!.requiredCapabilities,
        maxBudgetUsd: 1,
      });
      throw new Error('expected ProviderRuntimeFailure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRuntimeFailure);
      expect((error as ProviderRuntimeFailure).usage).toMatchObject({
        provider: 'anthropic-agent-sdk',
        costUsd: 0,
        accountingComplete: false,
      });
    }
  });

  it('preserves SDK terminal errors as accounting-complete provider failures', async () => {
    const target = mkdtempSync(join(tmpdir(), 'nunchi-provider-terminal-failure-'));
    const adapter = getDomainAdapter('soc', 'report');
    const phase = adapter.getPhase('evidence-review');
    const runtime = new AnthropicAgentRuntime(async () => ({
      texts: ['Unable to satisfy the requested schema.'],
      ledger: [],
      subtype: 'error_max_structured_output_retries',
      terminalReason: 'structured_output_retry_exhausted',
      errors: ['schema retries exhausted'],
      numTurns: 12,
      totalCostUsd: 0.75,
      modelUsage: { 'claude-opus-4-6': { inputTokens: 10, outputTokens: 20 } },
    }));
    try {
      await runtime.runPhase({
        contractId: adapter.contract.id,
        contractVersion: adapter.contract.version,
        domain: adapter.domain,
        mission: adapter.mission,
        phase: phase.workflow.id,
        role: phase.workflow.role,
        runId: 'run-terminal-failure',
        attempt: 'va:-:1',
        target,
        engagementDir: join(target, 'reports', 'run-terminal-failure'),
        prompt: 'test',
        requiredCapabilities: adapter.contract.roles[phase.workflow.role]!.requiredCapabilities,
        options: { model: 'claude-opus-4-6' },
      });
      throw new Error('expected ProviderRuntimeFailure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRuntimeFailure);
      expect(error).toHaveProperty('message', expect.stringContaining('error_max_structured_output_retries'));
      expect((error as ProviderRuntimeFailure).usage).toMatchObject({
        provider: 'anthropic-agent-sdk',
        turns: 12,
        costUsd: 0.75,
        accountingComplete: true,
      });
    }
  });

  it('rejects a successful SDK result that omits required structured output', async () => {
    const target = mkdtempSync(join(tmpdir(), 'nunchi-provider-missing-structured-'));
    const adapter = getDomainAdapter('soc', 'report');
    const phase = adapter.getPhase('evidence-review');
    const runtime = new AnthropicAgentRuntime(async () => ({
      texts: ['analysis complete'],
      ledger: [],
      subtype: 'success',
      terminalReason: 'completed',
      resultText: 'analysis complete',
      numTurns: 3,
      totalCostUsd: 0.2,
      modelUsage: { 'claude-opus-4-6': { inputTokens: 10, outputTokens: 20 } },
    }));

    await expect(runtime.runPhase({
      contractId: adapter.contract.id,
      contractVersion: adapter.contract.version,
      domain: adapter.domain,
      mission: adapter.mission,
      phase: phase.workflow.id,
      role: phase.workflow.role,
      runId: 'run-missing-structured',
      attempt: 'va:-:1',
      target,
      engagementDir: join(target, 'reports', 'run-missing-structured'),
      prompt: 'test',
      requiredCapabilities: adapter.contract.roles[phase.workflow.role]!.requiredCapabilities,
      options: { model: 'claude-opus-4-6' },
    })).rejects.toMatchObject({
      message: expect.stringContaining('구조화 출력 없이'),
      usage: expect.objectContaining({ accountingComplete: true, costUsd: 0.2 }),
    });
  });
});
