import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutoRenewingRunLease, InMemoryRunLeaseBackend } from '../workflow/run-lease.js';

afterEach(() => vi.useRealTimers());

describe('Run lease backend', () => {
  it('serializes owners and fences an expired worker', async () => {
    let now = Date.parse('2026-08-04T00:00:00.000Z');
    const backend = new InMemoryRunLeaseBackend(() => now);
    const first = await backend.acquire({ runId: 'run-1', ownerId: 'worker-a', ttlMs: 1_000 });
    await expect(backend.acquire({ runId: 'run-1', ownerId: 'worker-b', ttlMs: 1_000 })).rejects.toThrow(/사용 중/);
    now += 1_001;
    const second = await backend.acquire({ runId: 'run-1', ownerId: 'worker-b', ttlMs: 1_000 });
    expect(second.fencingToken).toBe(first.fencingToken + 1);
    await expect(backend.assertActive(first)).rejects.toThrow(/fencing token/);
    await expect(backend.assertActive(second)).resolves.toBeUndefined();
  });

  it('renews and releases only the matching lease', async () => {
    let now = Date.parse('2026-08-04T00:00:00.000Z');
    const backend = new InMemoryRunLeaseBackend(() => now);
    const lease = await backend.acquire({ runId: 'run-2', ownerId: 'worker-a', ttlMs: 1_000 });
    now += 500;
    const renewed = await backend.renew(lease, 2_000);
    now += 1_000;
    await expect(backend.assertActive(renewed)).resolves.toBeUndefined();
    await backend.release(renewed);
    await expect(backend.assertActive(renewed)).rejects.toThrow(/만료/);
  });

  it('renews an active guard before TTL expiry', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-04T00:00:00.000Z') });
    const backend = new InMemoryRunLeaseBackend();
    const guard = await AutoRenewingRunLease.acquire(backend, {
      runId: 'run-3', ownerId: 'worker-a', ttlMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    await expect(guard.assertActive()).resolves.toBeUndefined();
    await guard.release();
  });
});
