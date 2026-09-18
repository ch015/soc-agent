import { describe, expect, it, vi } from 'vitest';

import { buildPhaseMetrics, emitPhaseMetrics, type PhaseMetrics } from '../workflow/phase-metrics.js';

describe('buildPhaseMetrics', () => {
  it('correctly calculates estimatedContextUsagePercent', () => {
    const metrics = buildPhaseMetrics({
      runId: 'run-1',
      domain: 'offsec',
      phase: 'recon',
      agent: 'pentester',
      attempt: 1,
      usage: { inputTokens: 50_000, outputTokens: 10_000, cacheReadInputTokens: 40_000 },
      contextWindow: 200_000,
      startTime: Date.now() - 5000,
      validationPassed: true,
      qualityIssueCount: 0,
      costUsd: 0.5,
    });

    expect(metrics.inputTokens).toBe(50_000);
    expect(metrics.outputTokens).toBe(10_000);
    expect(metrics.cacheReadTokens).toBe(40_000);
    expect(metrics.totalTokens).toBe(100_000);
    expect(metrics.estimatedContextUsagePercent).toBe(50);
    expect(metrics.validationPassed).toBe(true);
    expect(metrics.costUsd).toBe(0.5);
  });

  it('handles missing/zero values gracefully', () => {
    const metrics = buildPhaseMetrics({
      runId: 'run-2',
      domain: 'feedback',
      phase: 'review',
      agent: 'reviewer',
      attempt: 2,
      usage: {},
      startTime: Date.now() - 100,
      validationPassed: false,
      qualityIssueCount: 3,
      costUsd: 0,
    });

    expect(metrics.inputTokens).toBe(0);
    expect(metrics.outputTokens).toBe(0);
    expect(metrics.cacheReadTokens).toBe(0);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.estimatedContextUsagePercent).toBe(0);
    expect(metrics.qualityIssueCount).toBe(3);
    expect(metrics.validationPassed).toBe(false);
    expect(metrics.costUsd).toBe(0);
    expect(metrics.duration).toBeGreaterThanOrEqual(0);
  });

  it('uses default context window of 200000 when not specified', () => {
    const metrics = buildPhaseMetrics({
      runId: 'run-3',
      domain: 'soc',
      phase: 'report',
      agent: 'analyst',
      attempt: 1,
      usage: { inputTokens: 100_000, outputTokens: 0 },
      startTime: Date.now(),
      validationPassed: true,
      qualityIssueCount: 0,
      costUsd: 0.1,
    });

    expect(metrics.estimatedContextUsagePercent).toBe(50);
  });

  it('handles zero context window without division error', () => {
    const metrics = buildPhaseMetrics({
      runId: 'run-4',
      domain: 'offsec',
      phase: 'vuln',
      agent: 'scanner',
      attempt: 1,
      usage: { inputTokens: 1000 },
      contextWindow: 0,
      startTime: Date.now(),
      validationPassed: true,
      qualityIssueCount: 0,
      costUsd: 0.01,
    });

    expect(metrics.estimatedContextUsagePercent).toBe(0);
  });
});

describe('emitPhaseMetrics', () => {
  it('outputs valid JSON to stderr', () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const metrics: PhaseMetrics = {
        runId: 'run-emit',
        domain: 'offsec',
        phase: 'recon',
        agent: 'pentester',
        attempt: 1,
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 200,
        totalTokens: 1700,
        estimatedContextUsagePercent: 0.85,
        duration: 3000,
        validationPassed: true,
        qualityIssueCount: 0,
        costUsd: 0.02,
      };

      emitPhaseMetrics(metrics);

      expect(writeSpy).toHaveBeenCalledTimes(1);
      const output = writeSpy.mock.calls[0]![0] as string;
      expect(output.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(output) as PhaseMetrics;
      expect(parsed.runId).toBe('run-emit');
      expect(parsed.phase).toBe('recon');
      expect(parsed.totalTokens).toBe(1700);
    } finally {
      writeSpy.mockRestore();
    }
  });
});
