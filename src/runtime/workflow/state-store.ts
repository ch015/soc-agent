import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { ArtifactRefSchema, ProviderUsageSchema } from '../contracts/result-contract.js';
import type { ArtifactReceipt } from './artifact-store.js';

export const HostInputRecordSchema = z.object({
  inputRevision: z.number().int().nonnegative(),
  contextEpoch: z.string().regex(/^[a-f0-9]{64}$/),
  manifest: ArtifactRefSchema,
  allowedReadFiles: z.array(z.string().min(1)).min(1),
  fileHashes: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
  }).strict()).min(1),
  parent: z.object({
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    triggerArtifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
}).strict();
export type HostInputRecord = z.infer<typeof HostInputRecordSchema>;

export const HostResourceReceiptSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
}).strict();
export type HostResourceReceipt = z.infer<typeof HostResourceReceiptSchema>;

const EventBaseSchema = z.object({
  seq: z.number().int().positive(),
  eventId: z.string().min(1),
  at: z.string().datetime(),
  runId: z.string().min(1),
});

const AttemptIdentitySchema = z.object({
  phase: z.string().min(1),
  round: z.string().min(1).optional(),
  attempt: z.number().int().positive(),
});

export const RunEventSchema = z.discriminatedUnion('type', [
  EventBaseSchema.extend({
    type: z.literal('run.created'),
    contractId: z.string().min(1),
    contractVersion: z.string().min(1),
    domain: z.string().min(1),
    mission: z.string().min(1),
    maxBudgetUsd: z.number().finite().positive().optional(),
  }),
  EventBaseSchema.extend({
    type: z.literal('input.recorded'),
    input: HostInputRecordSchema,
  }),
  EventBaseSchema.extend({
    type: z.literal('input.revised'),
    input: HostInputRecordSchema,
  }),
  EventBaseSchema.merge(AttemptIdentitySchema).extend({
    type: z.literal('phase.started'),
    hostResources: z.array(HostResourceReceiptSchema).min(1).optional(),
  }),
  EventBaseSchema.merge(AttemptIdentitySchema).extend({
    type: z.literal('attempt.received'),
    usage: ProviderUsageSchema,
  }),
  EventBaseSchema.merge(AttemptIdentitySchema).extend({
    type: z.literal('phase.context-compacted'),
    provider: z.string().min(1),
    trigger: z.enum(['manual', 'auto']),
    preTokens: z.number().int().nonnegative(),
    postTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    boundaryId: z.string().min(1),
  }),
  EventBaseSchema.merge(AttemptIdentitySchema).extend({
    type: z.literal('phase.result-identity-bound'),
    source: z.literal('host'),
    providerIdentity: z.enum(['absent', 'matched', 'overridden']),
    provider: z.string().min(1).optional(),
  }),
  EventBaseSchema.merge(AttemptIdentitySchema).extend({
    type: z.literal('phase.completed'),
    artifacts: z.array(ArtifactRefSchema),
    result: z.unknown(),
    hostResources: z.array(HostResourceReceiptSchema).min(1).optional(),
  }),
  EventBaseSchema.merge(AttemptIdentitySchema).extend({
    type: z.literal('phase.failed'),
    reason: z.string().min(1),
  }),
  EventBaseSchema.extend({ type: z.literal('run.completed') }),
  EventBaseSchema.extend({
    type: z.literal('run.awaiting-input'),
    reason: z.string().min(1),
    artifact: ArtifactRefSchema,
  }),
  EventBaseSchema.extend({ type: z.literal('run.resumed') }),
  EventBaseSchema.extend({
    type: z.literal('run.blocked'),
    reason: z.string().min(1),
  }),
  EventBaseSchema.extend({
    type: z.literal('publication.completed'),
    artifact: ArtifactRefSchema,
    sourceManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);

export type RunEvent = z.infer<typeof RunEventSchema>;
export type NewRunEvent = RunEvent extends infer Event
  ? Event extends RunEvent
    ? Omit<Event, 'seq' | 'at' | 'runId'>
    : never
  : never;

export type AttemptSnapshot = {
  phase: string;
  round?: string;
  attempt: number;
  status: 'started' | 'received' | 'completed' | 'failed';
  hostResources?: HostResourceReceipt[];
  usage?: z.infer<typeof ProviderUsageSchema>;
  artifacts?: z.infer<typeof ArtifactRefSchema>[];
  result?: unknown;
  failureReason?: string;
};

export type RunSnapshot = {
  runId: string;
  contractId: string;
  contractVersion: string;
  domain: string;
  mission: string;
  status: 'running' | 'awaiting-input' | 'completed' | 'blocked';
  maxBudgetUsd?: number;
  totalCostUsd: number;
  lastSeq: number;
  completedPhases: string[];
  attempts: Record<string, AttemptSnapshot>;
  inputManifest?: HostInputRecord;
  publication?: {
    artifact: z.infer<typeof ArtifactRefSchema>;
    sourceManifestSha256: string;
  };
  blockReason?: string;
  awaitingInput?: {
    reason: string;
    artifact: z.infer<typeof ArtifactRefSchema>;
  };
};

export const RUN_EVENTS_FILE = 'run-events.jsonl';
export const RUN_STATE_FILE = 'run-state.json';

export interface RunStateStore {
  readonly backend: 'file';
  read(): Readonly<RunSnapshot>;
  append(event: NewRunEvent): Readonly<RunSnapshot>;
  appendBatch(events: readonly NewRunEvent[], expectedLastSeq?: number): Readonly<RunSnapshot>;
}

/** Async backend contract used by the PostgreSQL implementation. */
export interface AsyncRunStateStore {
  readonly backend: 'postgres';
  read(): Promise<Readonly<RunSnapshot>>;
  append(
    event: NewRunEvent,
    expectedLastSeq?: number,
    fencingToken?: number,
  ): Promise<Readonly<RunSnapshot>>;
  appendBatch(
    events: readonly NewRunEvent[],
    expectedLastSeq?: number,
    fencingToken?: number,
  ): Promise<Readonly<RunSnapshot>>;
  appendBatchWithEffects(
    events: readonly NewRunEvent[],
    expectedLastSeq: number,
    fencingToken: number,
    effects?: RunStateEffects,
  ): Promise<Readonly<RunSnapshot>>;
}

export type RunStateBackend = RunStateStore | AsyncRunStateStore;

export type RunOutboxEffect = {
  id: string;
  idempotencyKey: string;
  topic: string;
  payload: unknown;
};

export type RunStateEffects = {
  artifactReceipts?: readonly ArtifactReceipt[];
  outbox?: readonly RunOutboxEffect[];
};

export function phaseAttemptKey(phase: string, round: string | undefined, attempt: number): string {
  return `${phase}:${round ?? '-'}:${attempt}`;
}

function emptySnapshot(created: Extract<RunEvent, { type: 'run.created' }>): RunSnapshot {
  return {
    runId: created.runId,
    contractId: created.contractId,
    contractVersion: created.contractVersion,
    domain: created.domain,
    mission: created.mission,
    status: 'running',
    maxBudgetUsd: created.maxBudgetUsd,
    totalCostUsd: 0,
    lastSeq: 0,
    completedPhases: [],
    attempts: {},
  };
}

function applyEvent(snapshot: RunSnapshot, event: RunEvent): void {
  if (event.runId !== snapshot.runId) throw new Error(`run event identity 불일치: ${event.runId}`);
  if (event.seq !== snapshot.lastSeq + 1) {
    throw new Error(`run event seq 불연속: ${event.seq} != ${snapshot.lastSeq + 1}`);
  }
  const resumeEvent = event.type === 'input.revised' || event.type === 'run.resumed';
  if (snapshot.status !== 'running' && event.type !== 'run.created' && !(snapshot.status === 'awaiting-input' && resumeEvent)) {
    throw new Error(`종료된 run에는 event를 추가할 수 없다: ${snapshot.status}`);
  }
  if (event.type === 'run.created') {
    if (snapshot.lastSeq !== 0) throw new Error('run.created가 중복됐다');
  } else if (event.type === 'input.recorded') {
    if (snapshot.inputManifest) throw new Error('host input manifest가 중복됐다');
    if (event.input.inputRevision !== 0 || event.input.parent) throw new Error('최초 host input revision이 잘못됐다');
    snapshot.inputManifest = event.input;
  } else if (event.type === 'input.revised') {
    if (snapshot.status !== 'awaiting-input' || !snapshot.inputManifest || !snapshot.awaitingInput) {
      throw new Error('대기 중인 host input만 revision할 수 있다');
    }
    if (event.input.inputRevision !== snapshot.inputManifest.inputRevision + 1) {
      throw new Error('host input revision이 연속적이지 않다');
    }
    if (!event.input.parent
      || event.input.parent.manifestSha256 !== snapshot.inputManifest.manifest.sha256
      || event.input.parent.triggerArtifactSha256 !== snapshot.awaitingInput.artifact.sha256) {
      throw new Error('host input revision lineage가 대기 상태와 다르다');
    }
    snapshot.inputManifest = event.input;
  } else if (
    event.type === 'phase.started' ||
    event.type === 'attempt.received' ||
    event.type === 'phase.context-compacted' ||
    event.type === 'phase.result-identity-bound' ||
    event.type === 'phase.completed' ||
    event.type === 'phase.failed'
  ) {
    const key = phaseAttemptKey(event.phase, event.round, event.attempt);
    const current = snapshot.attempts[key];
    if (event.type === 'phase.started') {
      if (current) throw new Error(`phase attempt가 이미 시작됐다: ${key}`);
      snapshot.attempts[key] = {
        phase: event.phase,
        ...(event.round ? { round: event.round } : {}),
        attempt: event.attempt,
        status: 'started',
        ...(event.hostResources ? { hostResources: event.hostResources } : {}),
      };
    } else {
      if (!current) throw new Error(`시작되지 않은 phase attempt다: ${key}`);
      if (current.status === 'completed' || current.status === 'failed') {
        throw new Error(`종료된 phase attempt에 event를 추가할 수 없다: ${key}`);
      }
      if (event.type === 'phase.context-compacted') {
        if (current.status !== 'started' && current.status !== 'received') {
          throw new Error(`종료된 phase attempt에는 compaction event를 추가할 수 없다: ${key}`);
        }
      } else if (event.type === 'phase.result-identity-bound') {
        if (current.status !== 'received') {
          throw new Error(`provider receipt 없이 identity binding event를 추가할 수 없다: ${key}`);
        }
      } else if (event.type === 'attempt.received') {
        if (current.status === 'received') throw new Error(`provider receipt가 중복됐다: ${key}`);
        current.status = 'received';
        current.usage = event.usage;
        snapshot.totalCostUsd += event.usage.costUsd;
      } else if (event.type === 'phase.completed') {
        if (current.status !== 'received') {
          throw new Error(`provider receipt 없이 phase를 완료할 수 없다: ${key}`);
        }
        if (!isDeepStrictEqual(current.hostResources ?? [], event.hostResources ?? [])) {
          throw new Error(`phase host resource receipt가 시작 event와 다르다: ${key}`);
        }
        current.status = 'completed';
        current.artifacts = event.artifacts;
        current.result = event.result;
        const phaseKey = event.round ? `${event.phase}:${event.round}` : event.phase;
        if (!snapshot.completedPhases.includes(phaseKey)) snapshot.completedPhases.push(phaseKey);
      } else {
        current.status = 'failed';
        current.failureReason = event.reason;
      }
    }
  } else if (event.type === 'run.awaiting-input') {
    if (snapshot.status !== 'running') throw new Error(`awaiting-input 전환은 실행 중인 run에서만 가능하다: ${snapshot.status}`);
    snapshot.status = 'awaiting-input';
    snapshot.awaitingInput = { reason: event.reason, artifact: event.artifact };
  } else if (event.type === 'run.resumed') {
    if (snapshot.status !== 'awaiting-input' || !snapshot.inputManifest?.parent) {
      throw new Error('revised input 없이 run을 재개할 수 없다');
    }
    snapshot.status = 'running';
    delete snapshot.awaitingInput;
  } else if (event.type === 'run.completed') {
    if (Object.values(snapshot.attempts).some((attempt) => attempt.status === 'started' || attempt.status === 'received')) {
      throw new Error('미종료 phase attempt가 있어 run을 완료할 수 없다');
    }
    snapshot.status = 'completed';
  } else if (event.type === 'publication.completed') {
    if (snapshot.publication) throw new Error('publication event가 중복됐다');
    if (event.artifact.producer.role !== 'host') {
      throw new Error('publication artifact producer가 host가 아니다');
    }
    snapshot.publication = {
      artifact: event.artifact,
      sourceManifestSha256: event.sourceManifestSha256,
    };
  } else {
    snapshot.status = 'blocked';
    snapshot.blockReason = event.reason;
  }
  snapshot.lastSeq = event.seq;
}

export function replayRunEvents(events: readonly RunEvent[]): RunSnapshot {
  const created = events[0];
  if (created?.type !== 'run.created') throw new Error('첫 run event가 run.created가 아니다');
  const snapshot = emptySnapshot(created);
  const eventIds = new Set<string>();
  for (const event of events) {
    if (eventIds.has(event.eventId)) throw new Error(`run event id가 중복됐다: ${event.eventId}`);
    eventIds.add(event.eventId);
    applyEvent(snapshot, event);
  }
  return structuredClone(snapshot);
}

export class FileRunStateStore implements RunStateStore {
  readonly backend = 'file' as const;
  readonly eventsPath: string;
  readonly snapshotPath: string;
  private snapshot: RunSnapshot;
  private readonly eventIds = new Set<string>();
  private readonly eventsById = new Map<string, RunEvent>();

  private constructor(readonly engagementDir: string, snapshot: RunSnapshot, events: RunEvent[]) {
    this.eventsPath = join(engagementDir, RUN_EVENTS_FILE);
    this.snapshotPath = join(engagementDir, RUN_STATE_FILE);
    this.snapshot = snapshot;
    for (const event of events) {
      this.eventIds.add(event.eventId);
      this.eventsById.set(event.eventId, event);
    }
  }

  static create(input: {
    engagementDir: string;
    runId: string;
    contractId: string;
    contractVersion: string;
    domain: string;
    mission: string;
    maxBudgetUsd?: number;
  }): FileRunStateStore {
    const engagementDir = resolve(input.engagementDir);
    if (basename(engagementDir) === '' || dirname(engagementDir) === engagementDir) {
      throw new Error(`run state 경로가 지나치게 넓다: ${engagementDir}`);
    }
    mkdirSync(engagementDir, { recursive: true, mode: 0o700 });
    const eventsPath = join(engagementDir, RUN_EVENTS_FILE);
    if (existsSync(eventsPath)) throw new Error(`run event ledger가 이미 있다: ${eventsPath}`);
    writeFileSync(eventsPath, '', { flag: 'wx', mode: 0o600 });
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
    const snapshot = emptySnapshot(created as Extract<RunEvent, { type: 'run.created' }>);
    applyEvent(snapshot, created);
    appendFileSync(eventsPath, `${JSON.stringify(created)}\n`, { encoding: 'utf8' });
    const store = new FileRunStateStore(engagementDir, snapshot, [created]);
    store.writeSnapshot();
    return store;
  }

  static open(engagementDir: string): FileRunStateStore {
    const root = resolve(engagementDir);
    const eventsPath = join(root, RUN_EVENTS_FILE);
    if (!existsSync(eventsPath)) throw new Error(`run event ledger가 없다: ${eventsPath}`);
    const events = readFileSync(eventsPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => RunEventSchema.parse(JSON.parse(line)));
    const snapshot = replayRunEvents(events);
    const store = new FileRunStateStore(root, snapshot, events);
    store.writeSnapshot();
    return store;
  }

  read(): Readonly<RunSnapshot> {
    return structuredClone(this.snapshot);
  }

  append(event: NewRunEvent): Readonly<RunSnapshot> {
    return this.appendBatch([event]);
  }

  appendBatch(events: readonly NewRunEvent[], expectedLastSeq = this.snapshot.lastSeq): Readonly<RunSnapshot> {
    if (expectedLastSeq !== this.snapshot.lastSeq) {
      throw new Error(`run state version 충돌: ${expectedLastSeq} != ${this.snapshot.lastSeq}`);
    }
    if (events.length === 0) return this.read();
    if (events.length === 1) {
      const event = events[0]!;
      const existing = this.eventsById.get(event.eventId);
      if (existing) {
        const { seq: _seq, at: _at, runId: _runId, ...existingPayload } = existing;
        if (!isDeepStrictEqual(existingPayload, event)) {
          throw new Error(`run event idempotency key 충돌: ${event.eventId}`);
        }
        return this.read();
      }
    }
    const batchIds = new Set<string>();
    for (const event of events) {
      if (!batchIds.add(event.eventId) || this.eventIds.has(event.eventId)) {
        throw new Error(`run event batch id가 중복됐다: ${event.eventId}`);
      }
    }
    const next = structuredClone(this.snapshot);
    const storedEvents: RunEvent[] = [];
    for (const [index, event] of events.entries()) {
      const stored = RunEventSchema.parse({
        ...event,
        seq: this.snapshot.lastSeq + index + 1,
        at: new Date().toISOString(),
        runId: this.snapshot.runId,
      });
      applyEvent(next, stored);
      storedEvents.push(stored);
    }
    appendFileSync(this.eventsPath, storedEvents.map((event) => `${JSON.stringify(event)}\n`).join(''), { encoding: 'utf8' });
    this.snapshot = next;
    for (const stored of storedEvents) {
      this.eventIds.add(stored.eventId);
      this.eventsById.set(stored.eventId, stored);
    }
    this.writeSnapshot();
    return this.read();
  }

  private writeSnapshot(): void {
    const temporary = join(
      this.engagementDir,
      `.${RUN_STATE_FILE}.${process.pid}.${this.snapshot.lastSeq}.tmp`,
    );
    writeFileSync(temporary, `${JSON.stringify(this.snapshot, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameSync(temporary, this.snapshotPath);
  }
}
