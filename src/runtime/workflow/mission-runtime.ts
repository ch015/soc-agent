import type { Pool } from 'pg';
import { relative, resolve, sep } from 'node:path';
import { realpathSync, statSync } from 'node:fs';

import { FileSystemArtifactStore, type ImmutableArtifactStore } from './artifact-store.js';
import { createPostgresPool } from './database.js';
import {
  PostgresRunStateStore,
  type PostgresRunEffects,
} from './postgres-run-state-store.js';
import {
  AutoRenewingRunLease,
  PostgresRunLeaseBackend,
  type RunLeaseBackend,
  type SqlPool,
} from './run-lease.js';
import {
  FileRunStateStore,
  type NewRunEvent,
  type RunSnapshot,
  type RunStateBackend,
} from './state-store.js';
import type { TelemetrySink } from './telemetry.js';

type DatabasePool = Pool & SqlPool;

export type MissionRuntimeOptions = {
  backend?: 'file' | 'postgres';
  pool?: DatabasePool;
  leaseBackend?: RunLeaseBackend;
  artifactStore?: ImmutableArtifactStore;
  telemetry?: TelemetrySink;
  workerId?: string;
  leaseTtlMs?: number;
  env?: NodeJS.ProcessEnv;
  sharedEngagementRoot?: string;
};

export type MissionRuntime = {
  state: RunStateBackend;
  artifactStore?: ImmutableArtifactStore;
  telemetry?: TelemetrySink;
  leaseGuard?: AutoRenewingRunLease;
  append(event: NewRunEvent, effects?: PostgresRunEffects): Promise<Readonly<RunSnapshot>>;
  appendBatch(events: readonly NewRunEvent[], effects?: PostgresRunEffects): Promise<Readonly<RunSnapshot>>;
  read(): Promise<Readonly<RunSnapshot>>;
  close(): Promise<void>;
};

type RunIdentity = {
  runId: string;
  contractId: string;
  contractVersion: string;
  domain: string;
  mission: string;
  maxBudgetUsd?: number;
};

export async function createMissionRuntime(
  input: RunIdentity & { engagementDir: string },
  options: MissionRuntimeOptions = {},
): Promise<MissionRuntime> {
  const backend = selectedBackend(options);
  if (backend === 'file') {
    return fileRuntime(FileRunStateStore.create(input), options);
  }
  assertSharedEngagementPath(input.engagementDir, options);
  const resources = postgresResources(options);
  try {
    const state = await PostgresRunStateStore.create(resources.pool, input);
    return await postgresRuntime(state, resources, input.runId, options);
  } catch (error) {
    if (resources.ownedPool) await resources.pool.end();
    throw error;
  }
}

export async function openMissionRuntime(
  input: { engagementDir: string; runId: string },
  options: MissionRuntimeOptions = {},
): Promise<MissionRuntime> {
  const backend = selectedBackend(options);
  if (backend === 'file') return fileRuntime(FileRunStateStore.open(input.engagementDir), options);
  assertSharedEngagementPath(input.engagementDir, options);
  const resources = postgresResources(options);
  try {
    const state = new PostgresRunStateStore(resources.pool, input.runId);
    await state.read();
    return await postgresRuntime(state, resources, input.runId, options);
  } catch (error) {
    if (resources.ownedPool) await resources.pool.end();
    throw error;
  }
}

function selectedBackend(options: MissionRuntimeOptions): 'file' | 'postgres' {
  const value = options.backend ?? options.env?.NUNCHI_STATE_BACKEND ?? process.env.NUNCHI_STATE_BACKEND ?? 'file';
  if (value !== 'file' && value !== 'postgres') throw new Error(`NUNCHI_STATE_BACKEND가 잘못됐다: ${value}`);
  return value;
}

function assertSharedEngagementPath(engagementDir: string, options: MissionRuntimeOptions): void {
  const rootValue = options.sharedEngagementRoot
    ?? options.env?.NUNCHI_SHARED_ENGAGEMENT_ROOT
    ?? process.env.NUNCHI_SHARED_ENGAGEMENT_ROOT;
  if (!rootValue) throw new Error('PostgreSQL mission에는 NUNCHI_SHARED_ENGAGEMENT_ROOT가 필요하다');
  const root = realpathSync(resolve(rootValue));
  const path = realpathSync(resolve(engagementDir));
  if (!statSync(path).isDirectory()) throw new Error(`PostgreSQL engagement가 directory가 아니다: ${path}`);
  const escaped = relative(root, path);
  if (escaped === '' || escaped === '..' || escaped.startsWith(`..${sep}`)) {
    throw new Error(`PostgreSQL engagement가 shared root 밖이다: ${path}`);
  }
}

function fileRuntime(state: FileRunStateStore, options: MissionRuntimeOptions): MissionRuntime {
  return {
    state,
    artifactStore: options.artifactStore,
    telemetry: options.telemetry,
    append: async (event) => state.append(event),
    appendBatch: async (events) => state.appendBatch(events),
    read: async () => state.read(),
    close: async () => undefined,
  };
}

function postgresResources(options: MissionRuntimeOptions): {
  pool: DatabasePool;
  ownedPool: boolean;
  artifactStore: ImmutableArtifactStore;
} {
  const env = options.env ?? process.env;
  const pool = options.pool ?? createPostgresPool(env);
  const artifactStore = options.artifactStore ?? (() => {
    const root = env.NUNCHI_ARTIFACT_ROOT;
    if (!root) throw new Error('PostgreSQL mission에는 NUNCHI_ARTIFACT_ROOT가 필요하다');
    return new FileSystemArtifactStore(root);
  })();
  return { pool, ownedPool: !options.pool, artifactStore };
}

async function postgresRuntime(
  state: PostgresRunStateStore,
  resources: { pool: DatabasePool; ownedPool: boolean; artifactStore: ImmutableArtifactStore },
  runId: string,
  options: MissionRuntimeOptions,
): Promise<MissionRuntime> {
  const lease = await AutoRenewingRunLease.acquire(
    options.leaseBackend ?? new PostgresRunLeaseBackend(resources.pool),
    {
      runId,
      ownerId: options.workerId ?? `mission-${process.pid}`,
      ttlMs: options.leaseTtlMs ?? 1_800_000,
    },
  );
  return {
    state,
    artifactStore: resources.artifactStore,
    telemetry: options.telemetry,
    leaseGuard: lease,
    append: async (event, effects = {}) => {
      await lease.assertActive();
      const snapshot = await state.read();
      return await state.appendBatchWithEffects(
        [event],
        snapshot.lastSeq,
        lease.fencingToken(),
        effects,
      );
    },
    appendBatch: async (events, effects = {}) => {
      await lease.assertActive();
      const snapshot = await state.read();
      return await state.appendBatchWithEffects(
        events,
        snapshot.lastSeq,
        lease.fencingToken(),
        effects,
      );
    },
    read: async () => await state.read(),
    close: async () => {
      try {
        await lease.release();
      } finally {
        if (resources.ownedPool) await resources.pool.end();
      }
    },
  };
}
