import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileSystemArtifactStore, InMemoryArtifactStore } from '../workflow/artifact-store.js';
import { deliverOutboxBatch, InMemoryOutboxStore, outboxPayloadHash } from '../workflow/outbox.js';

describe('immutable artifact store', () => {
  it('is create-if-absent and rejects URI metadata or content collisions', async () => {
    const store = new InMemoryArtifactStore();
    const input = { uri: 'artifact://run-1/a', content: new TextEncoder().encode('a'), mediaType: 'text/plain', producer: 'host/run-1' };
    const first = await store.put(input);
    expect(await store.put(input)).toEqual(first);
    expect(new TextDecoder().decode(await store.get(input.uri))).toBe('a');
    await expect(store.put({ ...input, content: new TextEncoder().encode('b') })).rejects.toThrow(/collision/);
    await expect(store.put({ ...input, mediaType: 'application/json' })).rejects.toThrow(/collision/);
  });

  it('persists filesystem artifacts, verifies reads, and rejects traversal or tampering', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nunchi-artifacts-'));
    const store = new FileSystemArtifactStore(root);
    const input = { uri: 'artifact://run-1/a.json', content: new TextEncoder().encode('{"ok":true}'), mediaType: 'application/json', producer: 'host/run-1' };
    try {
      const receipt = await store.put(input);
      expect(await store.put(input)).toEqual(receipt);
      expect(new TextDecoder().decode(await store.get(input.uri))).toBe('{"ok":true}');
      await expect(store.put({ ...input, content: new TextEncoder().encode('{"ok":false}') })).rejects.toThrow(/collision/);
      await expect(store.put({ ...input, uri: 'artifact://run-1/%2e%2e/secret' })).rejects.toThrow(/안전하지/);
      await writeFile(join(root, 'run-1', 'a.json'), '{"tampered":true}');
      await expect(store.get(input.uri)).rejects.toThrow(/다르다/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('at-least-once outbox test double', () => {
  it('hashes semantically identical JSON objects independently of key order', () => {
    expect(outboxPayloadHash({ zz: 1, a: { y: 2, x: 3 } }))
      .toBe(outboxPayloadHash({ a: { x: 3, y: 2 }, zz: 1 }));
  });

  it('deduplicates equal payloads, rejects collisions, and retries before dead-letter', async () => {
    const store = new InMemoryOutboxStore(2);
    const first = await store.enqueue({ idempotencyKey: 'event-1', topic: 'run.completed', payload: { runId: 'run-1' } });
    expect(await store.enqueue({ idempotencyKey: 'event-1', topic: 'run.completed', payload: { runId: 'run-1' } })).toEqual(first);
    await expect(store.enqueue({ idempotencyKey: 'event-1', topic: 'run.completed', payload: { runId: 'run-2' } })).rejects.toThrow(/collision/);
    const delivery1 = (await store.claim(1))[0]!;
    expect(delivery1.attempts).toBe(1);
    expect(delivery1.payload).toEqual({ runId: 'run-1' });
    await store.markFailed(delivery1.id, delivery1.claimToken!, 'temporary');
    const delivery2 = (await store.claim(1))[0]!;
    expect(delivery2.id).toBe(delivery1.id);
    expect(delivery2.attempts).toBe(2);
    await store.markFailed(delivery2.id, delivery2.claimToken!, 'permanent');
    expect(await store.claim(1)).toEqual([]);
  });

  it('reclaims expired deliveries and rejects a stale worker acknowledgement', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const store = new InMemoryOutboxStore(3, 1_000, () => now);
    await store.enqueue({ idempotencyKey: 'event-2', topic: 'run.completed', payload: { runId: 'run-2' } });
    const abandoned = (await store.claim(1))[0]!;
    now += 1_001;
    await expect(store.markDelivered(abandoned.id, abandoned.claimToken!)).rejects.toThrow(/claim/);
    const reclaimed = (await store.claim(1))[0]!;
    expect(reclaimed.id).toBe(abandoned.id);
    expect(reclaimed.attempts).toBe(2);
    expect(reclaimed.claimToken).not.toBe(abandoned.claimToken);
    await expect(store.markDelivered(abandoned.id, abandoned.claimToken!)).rejects.toThrow(/claim/);
    await store.markDelivered(reclaimed.id, reclaimed.claimToken!);
  });

  it('dead-letters a delivery after repeated worker crashes exhaust attempts', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const store = new InMemoryOutboxStore(2, 1_000, () => now);
    await store.enqueue({ idempotencyKey: 'event-crash', topic: 'run.completed', payload: { runId: 'run-crash' } });
    expect((await store.claim(1))[0]?.attempts).toBe(1);
    now += 1_001;
    expect((await store.claim(1))[0]?.attempts).toBe(2);
    now += 1_001;
    expect(await store.claim(1)).toEqual([]);
  });

  it('delivers claimed payloads through the worker helper', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue({ idempotencyKey: 'event-3', topic: 'run.completed', payload: { runId: 'run-3' } });
    const seen: unknown[] = [];
    expect(await deliverOutboxBatch(store, 10, async (message) => {
      seen.push(message.payload);
    })).toEqual({ delivered: 1, failed: 0 });
    expect(seen).toEqual([{ runId: 'run-3' }]);
    expect(await store.claim(1)).toEqual([]);
  });

  it('preserves an unknown delivery outcome when acknowledgement expires after delivery', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const store = new InMemoryOutboxStore(3, 1_000, () => now);
    await store.enqueue({ idempotencyKey: 'event-ack', topic: 'run.completed', payload: { runId: 'run-ack' } });
    await expect(deliverOutboxBatch(store, 1, async () => {
      now += 1_001;
    })).rejects.toThrow(/outcome/);
    const retried = (await store.claim(1))[0]!;
    expect(retried.attempts).toBe(2);
  });
});
