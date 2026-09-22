/** Tests for SOC signal ingress: parsing, validation, dedup, priority, correlation. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SocSignalSchema, SEVERITY_PRIORITY_MAP } from '../adapters/soc/types.js';
import type { SocSignal } from '../adapters/soc/types.js';
import { severityToPriority, isImmediatePriority } from '../adapters/soc/priority.js';
import { SignalCorrelation } from '../adapters/soc/correlation.js';
import { buildQueryPlan } from '../adapters/soc/query-builder.js';

function makeValidSignal(overrides: Partial<SocSignal> = {}): SocSignal {
  return {
    signalId: 'det-20260812-abc123',
    signalType: 'detection',
    source: 'secops-nunchi-detection',
    severity: 'high',
    timestamp: '2026-08-12T09:15:00Z',
    subject: { type: 'ip', value: '203.0.113.42' },
    rule: {
      id: 'T1078.004',
      name: 'Valid Accounts: Cloud Accounts',
      category: 'initial-access',
    },
    timeContext: {
      firstSeen: '2026-08-12T09:10:00Z',
      lastSeen: '2026-08-12T09:15:00Z',
      suggestedWindow: '1h',
    },
    tenantId: 'tenant-internal',
    ...overrides,
  };
}

describe('SOC Signal Schema Validation', () => {
  it('accepts a valid signal', () => {
    const signal = makeValidSignal();
    const result = SocSignalSchema.safeParse(signal);
    expect(result.success).toBe(true);
  });

  it('accepts all signal types', () => {
    for (const signalType of ['alert', 'detection', 'anomaly', 'correlation'] as const) {
      const signal = makeValidSignal({ signalType });
      const result = SocSignalSchema.safeParse(signal);
      expect(result.success).toBe(true);
    }
  });

  it('accepts all subject types', () => {
    for (const type of ['ip', 'user', 'host', 'service', 'domain', 'hash'] as const) {
      const signal = makeValidSignal({ subject: { type, value: 'test-value' } });
      const result = SocSignalSchema.safeParse(signal);
      expect(result.success).toBe(true);
    }
  });

  it('rejects missing signalId', () => {
    const signal = makeValidSignal();
    delete (signal as Record<string, unknown>).signalId;
    const result = SocSignalSchema.safeParse(signal);
    expect(result.success).toBe(false);
  });

  it('rejects invalid severity', () => {
    const signal = makeValidSignal({ severity: 'extreme' as unknown as SocSignal['severity'] });
    const result = SocSignalSchema.safeParse(signal);
    expect(result.success).toBe(false);
  });

  it('rejects invalid timestamp format', () => {
    const signal = makeValidSignal({ timestamp: 'not-a-date' });
    const result = SocSignalSchema.safeParse(signal);
    expect(result.success).toBe(false);
  });

  it('accepts signal without optional fields', () => {
    const signal: Record<string, unknown> = {
      signalId: 'test-001',
      signalType: 'alert',
      source: 'test-source',
      severity: 'low',
      timestamp: '2026-08-12T09:15:00Z',
      subject: { type: 'ip', value: '10.0.0.1' },
      tenantId: 'tenant-1',
    };
    const result = SocSignalSchema.safeParse(signal);
    expect(result.success).toBe(true);
  });

  it('accepts signal with rawEvents', () => {
    const signal = makeValidSignal({
      rawEvents: [
        { source: 'syslog', eventId: 'evt-001', summary: 'Login attempt' },
      ],
    });
    const result = SocSignalSchema.safeParse(signal);
    expect(result.success).toBe(true);
  });

  it('accepts signal with tags', () => {
    const signal = makeValidSignal({ tags: ['mitre:T1078', 'critical-asset'] });
    const result = SocSignalSchema.safeParse(signal);
    expect(result.success).toBe(true);
  });
});

describe('Priority Mapping', () => {
  it('maps critical to priority 1 (highest)', () => {
    expect(severityToPriority('critical')).toBe(1);
    expect(SEVERITY_PRIORITY_MAP.critical).toBe(1);
  });

  it('maps high to priority 2', () => {
    expect(severityToPriority('high')).toBe(2);
  });

  it('maps medium to priority 3', () => {
    expect(severityToPriority('medium')).toBe(3);
  });

  it('maps low to priority 4', () => {
    expect(severityToPriority('low')).toBe(4);
  });

  it('maps info to priority 5 (lowest)', () => {
    expect(severityToPriority('info')).toBe(5);
  });

  it('classifies critical and high as immediate priority', () => {
    expect(isImmediatePriority('critical')).toBe(true);
    expect(isImmediatePriority('high')).toBe(true);
    expect(isImmediatePriority('medium')).toBe(false);
    expect(isImmediatePriority('low')).toBe(false);
    expect(isImmediatePriority('info')).toBe(false);
  });
});

describe('Signal Correlation', () => {
  let mockRedis: {
    exists: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
  };
  let correlation: SignalCorrelation;

  beforeEach(() => {
    mockRedis = {
      exists: vi.fn(),
      get: vi.fn(),
      set: vi.fn(),
    };
    correlation = new SignalCorrelation(mockRedis as unknown as import('ioredis').Redis);
  });

  it('detects duplicate by signalId', async () => {
    mockRedis.exists.mockResolvedValue(1);
    const isDuplicate = await correlation.bySignalId('tenant-internal', 'det-001');
    expect(isDuplicate).toBe(true);
    expect(mockRedis.exists).toHaveBeenCalledWith('secops-soc:dedup:["tenant-internal","det-001"]');
  });

  it('returns false for new signalId', async () => {
    mockRedis.exists.mockResolvedValue(0);
    const isDuplicate = await correlation.bySignalId('tenant-internal', 'det-new');
    expect(isDuplicate).toBe(false);
  });

  it('correlates by subject+rule within window', async () => {
    mockRedis.get.mockResolvedValue('existing-job-123');
    const signal = makeValidSignal();
    const jobId = await correlation.byCorrelation(signal);
    expect(jobId).toBe('existing-job-123');
    expect(mockRedis.get).toHaveBeenCalledWith(
      'secops-soc:corr:["tenant-internal","ip","203.0.113.42","T1078.004"]',
    );
  });

  it('returns null when no correlation exists', async () => {
    mockRedis.get.mockResolvedValue(null);
    const signal = makeValidSignal();
    const jobId = await correlation.byCorrelation(signal);
    expect(jobId).toBeNull();
  });

  it('returns null for signals without rule', async () => {
    const signal = makeValidSignal({ rule: undefined });
    const jobId = await correlation.byCorrelation(signal);
    expect(jobId).toBeNull();
    expect(mockRedis.get).not.toHaveBeenCalled();
  });

  it('marks signal as seen with TTL', async () => {
    mockRedis.set.mockResolvedValue('OK');
    await correlation.markSeen('tenant-internal', 'det-001', 'job-123');
    expect(mockRedis.set).toHaveBeenCalledWith('secops-soc:dedup:["tenant-internal","det-001"]', 'job-123', 'EX', 300);
  });

  it('sets correlation key with TTL', async () => {
    mockRedis.set.mockResolvedValue('OK');
    const signal = makeValidSignal();
    await correlation.setCorrelation(signal, 'job-456');
    expect(mockRedis.set).toHaveBeenCalledWith(
      'secops-soc:corr:["tenant-internal","ip","203.0.113.42","T1078.004"]',
      'job-456',
      'EX',
      300,
    );
  });

  it('keeps identical signal IDs independent across tenants', async () => {
    const values = new Map<string, string>();
    mockRedis.set.mockImplementation(async (key, value) => { values.set(key, value); return 'OK'; });
    mockRedis.exists.mockImplementation(async key => values.has(key) ? 1 : 0);
    await correlation.markSeen('tenant-a', 'same-id', 'job-a');
    expect(await correlation.bySignalId('tenant-a', 'same-id')).toBe(true);
    expect(await correlation.bySignalId('tenant-b', 'same-id')).toBe(false);
  });

  it('does not conflate delimiter-bearing subject and rule pairs', async () => {
    const values = new Map<string, string>();
    mockRedis.set.mockImplementation(async (key, value) => { values.set(key, value); return 'OK'; });
    mockRedis.get.mockImplementation(async key => values.get(key) ?? null);
    const original = makeValidSignal({ subject: { type: 'host', value: 'a:b' }, rule: { id: 'c', name: 'r', category: 'test' } });
    await correlation.setCorrelation(original, 'job-a');
    expect(await correlation.byCorrelation(original)).toBe('job-a');
    expect(await correlation.byCorrelation({ ...original, subject: { type: 'host', value: 'a' }, rule: { ...original.rule!, id: 'b:c' } })).toBeNull();
  });
});

describe('Query Plan Builder', () => {
  it('builds plan from signal with timeContext and suggestedWindow', () => {
    const signal = makeValidSignal();
    const plan = buildQueryPlan(signal);

    expect(plan.index).toBe('*');
    expect(plan.maxRows).toBe(10_000);
    expect(plan.timeoutMs).toBe(60_000);
    expect(plan.filters).toHaveLength(1);
    expect(plan.filters[0]).toEqual({ field: 'source.ip', value: '203.0.113.42' });
    expect(plan.ruleFilter).toEqual({ field: 'rule.id', value: 'T1078.004' });
    // 1h window before lastSeen
    expect(plan.timeRange.lte).toBe('2026-08-12T09:15:00Z');
  });

  it('builds plan with custom index', () => {
    const signal = makeValidSignal();
    const plan = buildQueryPlan(signal, 'security-logs-*');
    expect(plan.index).toBe('security-logs-*');
  });

  it('uses default window when no timeContext', () => {
    const signal = makeValidSignal({ timeContext: undefined });
    const plan = buildQueryPlan(signal);
    // Default 1h window before timestamp
    expect(plan.timeRange.lte).toBe('2026-08-12T09:15:00Z');
    const gteMs = new Date(plan.timeRange.gte).getTime();
    const lteMs = new Date(plan.timeRange.lte).getTime();
    expect(lteMs - gteMs).toBe(60 * 60 * 1000); // 1h
  });

  it('maps user subject to user.name field', () => {
    const signal = makeValidSignal({ subject: { type: 'user', value: 'admin@corp.com' } });
    const plan = buildQueryPlan(signal);
    expect(plan.filters[0]).toEqual({ field: 'user.name', value: 'admin@corp.com' });
  });

  it('maps host subject to host.name field', () => {
    const signal = makeValidSignal({ subject: { type: 'host', value: 'web-prod-01' } });
    const plan = buildQueryPlan(signal);
    expect(plan.filters[0]).toEqual({ field: 'host.name', value: 'web-prod-01' });
  });

  it('omits rule filter when signal has no rule', () => {
    const signal = makeValidSignal({ rule: undefined });
    const plan = buildQueryPlan(signal);
    expect(plan.ruleFilter).toBeUndefined();
  });

  it('caps window at 24h maximum', () => {
    const signal = makeValidSignal({
      timeContext: {
        firstSeen: '2026-08-10T00:00:00Z',
        lastSeen: '2026-08-12T09:15:00Z',
        suggestedWindow: '48h',
      },
    });
    const plan = buildQueryPlan(signal);
    const gteMs = new Date(plan.timeRange.gte).getTime();
    const lteMs = new Date(plan.timeRange.lte).getTime();
    expect(lteMs - gteMs).toBe(24 * 60 * 60 * 1000); // capped at 24h
  });
});
