import { isDeepStrictEqual } from 'node:util';

import {
  replayRunEvents,
  RunEventSchema,
  type AsyncRunStateStore,
  type NewRunEvent,
  type RunEvent,
  type RunStateEffects,
  type RunSnapshot,
} from './state-store.js';
import type { SqlConnection, SqlPool } from './run-lease.js';
import { ArtifactReceiptSchema, type ArtifactReceipt } from './artifact-store.js';
import { canonicalJson, outboxPayloadHash } from './outbox.js';

type RunRow = { last_seq: number | string };
type EventRow = { payload: unknown };

export type PostgresRunEffects = RunStateEffects;

function jsonValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function parseEvent(row: EventRow): RunEvent {
  return RunEventSchema.parse(jsonValue(row.payload));
}

function comparableEvent(event: RunEvent | NewRunEvent): unknown {
  const { seq: _seq, at: _at, runId: _runId, ...payload } = event as RunEvent;
  return payload;
}

function assertExpectedEvent(existing: RunEvent, requested: NewRunEvent): void {
  if (!isDeepStrictEqual(comparableEvent(existing), comparableEvent(requested))) {
    throw new Error(`run event idempotency key 충돌: ${requested.eventId}`);
  }
}

export class PostgresRunStateStore implements AsyncRunStateStore {
  readonly backend = 'postgres' as const;

  constructor(
    private readonly pool: SqlPool,
    readonly runId: string,
  ) {
    if (!runId) throw new Error('PostgreSQL run state runId가 비어 있다');
  }

  static async create(pool: SqlPool, input: {
    runId: string;
    contractId: string;
    contractVersion: string;
    domain: string;
    mission: string;
    maxBudgetUsd?: number;
  }): Promise<PostgresRunStateStore> {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      const created = RunEventSchema.parse({
        seq: 1,
        eventId: `${input.runId}:created`,
        at: new Date().toISOString(),
        runId: input.runId,
        type: 'run.created',
        contractId: input.contractId,
        contractVersion: input.contractVersion,
        domain: input.domain,
        mission: input.mission,
        maxBudgetUsd: input.maxBudgetUsd,
      });
      const snapshot = replayRunEvents([created]);
      await connection.query(`
        INSERT INTO nunchi_runs
          (run_id, contract_id, contract_version, domain, mission, status,
           max_budget_usd, total_cost_usd, last_seq, state)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      `, [
        input.runId,
        input.contractId,
        input.contractVersion,
        input.domain,
        input.mission,
        snapshot.status,
        snapshot.maxBudgetUsd ?? null,
        snapshot.totalCostUsd,
        snapshot.lastSeq,
        JSON.stringify(snapshot),
      ]);
      await connection.query(`
        INSERT INTO nunchi_run_events
          (run_id, seq, event_id, fencing_token, event_type, payload)
        VALUES ($1, $2, $3, 0, $4, $5::jsonb)
      `, [input.runId, created.seq, created.eventId, created.type, JSON.stringify(created)]);
      await connection.query('COMMIT');
      return new PostgresRunStateStore(pool, input.runId);
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  async read(): Promise<Readonly<RunSnapshot>> {
    const result = await this.pool.query<EventRow>(
      'SELECT payload FROM nunchi_run_events WHERE run_id = $1 ORDER BY seq',
      [this.runId],
    );
    if (result.rows.length === 0) throw new Error(`PostgreSQL run state가 없다: ${this.runId}`);
    return replayRunEvents(result.rows.map(parseEvent));
  }

  async append(event: NewRunEvent, expectedLastSeq?: number, fencingToken?: number): Promise<Readonly<RunSnapshot>> {
    return await this.appendBatch([event], expectedLastSeq, fencingToken);
  }

  async appendBatch(
    events: readonly NewRunEvent[],
    expectedLastSeq?: number,
    fencingToken?: number,
  ): Promise<Readonly<RunSnapshot>> {
    return await this.appendBatchWithEffects(events, expectedLastSeq, fencingToken);
  }

  async appendBatchWithEffects(
    events: readonly NewRunEvent[],
    expectedLastSeq?: number,
    fencingToken?: number,
    effects: RunStateEffects = {},
  ): Promise<Readonly<RunSnapshot>> {
    if (expectedLastSeq === undefined) throw new Error('PostgreSQL append에는 expectedLastSeq가 필요하다');
    if (fencingToken === undefined) throw new Error('PostgreSQL append에는 fencingToken이 필요하다');
    if (events.length === 0) return await this.read();
    const eventIds = new Set<string>();
    for (const event of events) {
      if (!eventIds.add(event.eventId)) throw new Error(`run event batch id가 중복됐다: ${event.eventId}`);
    }

    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const runResult = await connection.query<RunRow>(
        'SELECT last_seq FROM nunchi_runs WHERE run_id = $1 FOR UPDATE',
        [this.runId],
      );
      const run = runResult.rows[0];
      if (!run) throw new Error(`PostgreSQL run state가 없다: ${this.runId}`);
      const lastSeq = Number(run.last_seq);
      if (lastSeq !== expectedLastSeq) {
        throw new Error(`run state version 충돌: ${expectedLastSeq} != ${lastSeq}`);
      }
      const lease = await connection.query(
        `SELECT 1 FROM nunchi_run_leases
         WHERE run_id = $1 AND fencing_token = $2 AND expires_at > clock_timestamp()
         FOR UPDATE`,
        [this.runId, fencingToken],
      );
      if (lease.rows.length === 0) {
        throw new Error(`run lease가 만료되었거나 fencing token이 다르다: ${this.runId}`);
      }

      const existingEvents = await this.readEvents(connection);
      const existingById = new Map(existingEvents.map((candidate) => [candidate.eventId, candidate]));
      if (events.length === 1) {
        const existing = existingById.get(events[0]!.eventId);
        if (existing) {
          assertExpectedEvent(existing, events[0]!);
          await connection.query('COMMIT');
          return replayRunEvents(existingEvents);
        }
      } else if (events.some((event) => existingById.has(event.eventId))) {
        throw new Error('run event batch에는 이미 저장된 id가 포함될 수 없다');
      }

      const storedEvents = events.map((event, index) => RunEventSchema.parse({
        ...event,
        seq: lastSeq + index + 1,
        at: new Date().toISOString(),
        runId: this.runId,
      }));
      const snapshot = replayRunEvents([...existingEvents, ...storedEvents]);
      for (const stored of storedEvents) {
        await connection.query(`
          INSERT INTO nunchi_run_events
            (run_id, seq, event_id, fencing_token, event_type, payload)
          VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        `, [
          this.runId,
          stored.seq,
          stored.eventId,
          fencingToken,
          stored.type,
          JSON.stringify(stored),
        ]);
      }
      await this.insertArtifactReceipts(connection, effects.artifactReceipts ?? []);
      await this.insertOutbox(connection, effects.outbox ?? []);
      await connection.query(`
        UPDATE nunchi_runs
        SET status = $2, max_budget_usd = $3, total_cost_usd = $4,
            last_seq = $5, state = $6::jsonb, updated_at = clock_timestamp()
        WHERE run_id = $1
      `, [
        this.runId,
        snapshot.status,
        snapshot.maxBudgetUsd ?? null,
        snapshot.totalCostUsd,
        snapshot.lastSeq,
        JSON.stringify(snapshot),
      ]);
      await connection.query('COMMIT');
      return snapshot;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  private async readEvents(connection: SqlConnection): Promise<RunEvent[]> {
    const result = await connection.query<EventRow>(
      'SELECT payload FROM nunchi_run_events WHERE run_id = $1 ORDER BY seq',
      [this.runId],
    );
    return result.rows.map(parseEvent);
  }

  private async insertArtifactReceipts(
    connection: SqlConnection,
    receipts: readonly ArtifactReceipt[],
  ): Promise<void> {
    for (const receipt of receipts) {
      const parsed = ArtifactReceiptSchema.parse(receipt);
      await connection.query(`
        INSERT INTO nunchi_artifact_receipts (uri, sha256, bytes, media_type, producer)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (uri) DO NOTHING
      `, [parsed.uri, parsed.sha256, parsed.bytes, parsed.mediaType, parsed.producer]);
      const existing = await connection.query<ArtifactReceiptRow>(
        'SELECT uri, sha256, bytes, media_type, producer FROM nunchi_artifact_receipts WHERE uri = $1',
        [parsed.uri],
      );
      const row = existing.rows[0];
      if (!row || row.sha256 !== parsed.sha256 || Number(row.bytes) !== parsed.bytes
        || row.media_type !== parsed.mediaType || row.producer !== parsed.producer) {
        throw new Error(`immutable artifact URI collision: ${parsed.uri}`);
      }
    }
  }

  private async insertOutbox(
    connection: SqlConnection,
    messages: readonly NonNullable<RunStateEffects['outbox']>[number][],
  ): Promise<void> {
    for (const message of messages) {
      const payloadSha256 = outboxPayloadHash(message.payload);
      await connection.query(`
        INSERT INTO nunchi_outbox
          (id, idempotency_key, topic, payload_sha256, payload, status, attempts)
        VALUES ($1, $2, $3, $4, $5::jsonb, 'queued', 0)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [message.id, message.idempotencyKey, message.topic, payloadSha256, canonicalJson(message.payload)]);
      const existing = await connection.query<OutboxRow>(
        'SELECT id, idempotency_key, topic, payload_sha256 FROM nunchi_outbox WHERE idempotency_key = $1',
        [message.idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row || row.id !== message.id || row.topic !== message.topic || row.payload_sha256 !== payloadSha256) {
        throw new Error(`outbox idempotency key collision: ${message.idempotencyKey}`);
      }
    }
  }
}

type ArtifactReceiptRow = {
  uri: string;
  sha256: string;
  bytes: number | string;
  media_type: string;
  producer: string;
};

type OutboxRow = {
  id: string;
  idempotency_key: string;
  topic: string;
  payload_sha256: string;
};
