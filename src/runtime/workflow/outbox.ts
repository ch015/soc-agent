import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

const OutboxStatusSchema = z.enum(['queued', 'delivering', 'delivered', 'dead-letter']);

export const OutboxMessageSchema = z.object({
  id: z.string().min(1),
  idempotencyKey: z.string().min(1),
  topic: z.string().min(1),
  payload: z.unknown(),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  status: OutboxStatusSchema,
  attempts: z.number().int().nonnegative(),
  claimToken: z.string().uuid().optional(),
  claimExpiresAt: z.string().datetime({ offset: true }).optional(),
  lastError: z.string().min(1).optional(),
}).strict();

export type OutboxMessage = z.infer<typeof OutboxMessageSchema>;

export interface OutboxStore {
  enqueue(input: { idempotencyKey: string; topic: string; payload: unknown }): Promise<OutboxMessage>;
  claim(limit: number): Promise<OutboxMessage[]>;
  markDelivered(id: string, claimToken: string): Promise<void>;
  markFailed(id: string, claimToken: string, reason: string): Promise<void>;
}

export function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('outbox payload는 JSON 값이어야 한다');
  const parsed = JSON.parse(serialized) as unknown;
  return JSON.stringify(sortJson(parsed));
}

export function outboxPayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}

export class InMemoryOutboxStore implements OutboxStore {
  private nextId = 0;
  private readonly messages = new Map<string, OutboxMessage>();

  constructor(
    private readonly maxAttempts = 3,
    private readonly visibilityTimeoutMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('outbox maxAttempts가 잘못됐다');
    if (!Number.isInteger(visibilityTimeoutMs) || visibilityTimeoutMs < 1) {
      throw new Error('outbox visibilityTimeoutMs가 잘못됐다');
    }
  }

  async enqueue(input: { idempotencyKey: string; topic: string; payload: unknown }): Promise<OutboxMessage> {
    const hash = outboxPayloadHash(input.payload);
    const existing = [...this.messages.values()].find((message) => message.idempotencyKey === input.idempotencyKey);
    if (existing) {
      if (existing.payloadSha256 !== hash || existing.topic !== input.topic) {
        throw new Error(`outbox idempotency key collision: ${input.idempotencyKey}`);
      }
      return structuredClone(existing);
    }
    const message = OutboxMessageSchema.parse({
      id: `outbox-${++this.nextId}`,
      idempotencyKey: input.idempotencyKey,
      topic: input.topic,
      payload: structuredClone(input.payload),
      payloadSha256: hash,
      status: 'queued',
      attempts: 0,
    });
    this.messages.set(message.id, message);
    return structuredClone(message);
  }

  async claim(limit: number): Promise<OutboxMessage[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('outbox claim limit가 잘못됐다');
    const claimed: OutboxMessage[] = [];
    for (const current of this.messages.values()) {
      const expired = current.status === 'delivering'
        && current.claimExpiresAt !== undefined
        && Date.parse(current.claimExpiresAt) <= this.now();
      const message = expired
        ? OutboxMessageSchema.parse({
            ...current,
            status: current.attempts >= this.maxAttempts ? 'dead-letter' : 'queued',
            claimToken: undefined,
            claimExpiresAt: undefined,
            lastError: 'delivery claim expired',
          })
        : current;
      if (expired) this.messages.set(message.id, message);
      if (message.status !== 'queued' || claimed.length >= limit) continue;
      const next = OutboxMessageSchema.parse({
        ...message,
        status: 'delivering',
        attempts: message.attempts + 1,
        claimToken: randomUUID(),
        claimExpiresAt: new Date(this.now() + this.visibilityTimeoutMs).toISOString(),
      });
      this.messages.set(message.id, next);
      claimed.push(structuredClone(next));
    }
    return claimed;
  }

  async markDelivered(id: string, claimToken: string): Promise<void> {
    const message = this.messages.get(id);
    if (!message || message.status !== 'delivering' || message.claimToken !== claimToken
      || !message.claimExpiresAt || Date.parse(message.claimExpiresAt) <= this.now()) {
      throw new Error(`outbox delivery claim이 유효하지 않다: ${id}`);
    }
    this.messages.set(id, OutboxMessageSchema.parse({
      ...message,
      status: 'delivered',
      claimToken: undefined,
      claimExpiresAt: undefined,
    }));
  }

  async markFailed(id: string, claimToken: string, reason: string): Promise<void> {
    if (!reason) throw new Error('outbox failure reason이 비어 있다');
    const message = this.messages.get(id);
    if (!message || message.status !== 'delivering' || message.claimToken !== claimToken
      || !message.claimExpiresAt || Date.parse(message.claimExpiresAt) <= this.now()) {
      throw new Error(`outbox failure claim이 유효하지 않다: ${id}`);
    }
    this.messages.set(id, OutboxMessageSchema.parse({
      ...message,
      status: message.attempts >= this.maxAttempts ? 'dead-letter' : 'queued',
      claimToken: undefined,
      claimExpiresAt: undefined,
      lastError: reason,
    }));
  }
}

export async function deliverOutboxBatch(
  store: OutboxStore,
  limit: number,
  deliver: (message: OutboxMessage) => Promise<void>,
): Promise<{ delivered: number; failed: number }> {
  const messages = await store.claim(limit);
  let delivered = 0;
  let failed = 0;
  for (const message of messages) {
    const claimToken = message.claimToken;
    if (!claimToken) throw new Error(`outbox claim token이 없다: ${message.id}`);
    try {
      await deliver(message);
    } catch (error) {
      await store.markFailed(message.id, claimToken, error instanceof Error ? error.message : String(error));
      failed += 1;
      continue;
    }
    try {
      await store.markDelivered(message.id, claimToken);
    } catch (error) {
      throw new Error(`outbox delivery outcome을 확정할 수 없다: ${message.id}`, { cause: error });
    }
    delivered += 1;
  }
  return { delivered, failed };
}
