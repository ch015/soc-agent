import { z } from 'zod';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { RunSnapshot } from './state-store.js';

export const TelemetryEventSchema = z.object({
  eventId: z.string().min(1),
  at: z.string().datetime(),
  kind: z.enum(['run.snapshot', 'reconcile', 'resume', 'lease', 'outbox']),
  runId: z.string().min(1),
  contractId: z.string().min(1),
  contractVersion: z.string().min(1),
  domain: z.string().min(1),
  mission: z.string().min(1),
  status: z.enum(['running', 'awaiting-input', 'completed', 'blocked']),
  lastSeq: z.number().int().nonnegative(),
  totalCostUsd: z.number().nonnegative(),
  completedPhaseCount: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  inputRevision: z.number().int().nonnegative().optional(),
  contextEpoch: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  latencyMs: z.number().int().nonnegative().optional(),
  reasonCode: z.enum([
    'provider-error',
    'accounting-incomplete',
    'validation-blocked',
    'host-resource-mismatch',
    'lease-lost',
    'version-conflict',
    'awaiting-input',
    'reconciled',
    'unknown',
  ]).optional(),
}).strict();

export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

export interface TelemetrySink {
  append(event: TelemetryEvent): Promise<void> | void;
}

export class InMemoryTelemetrySink implements TelemetrySink {
  private readonly records: TelemetryEvent[] = [];

  append(event: TelemetryEvent): void {
    this.records.push(TelemetryEventSchema.parse(structuredClone(event)));
  }

  list(): readonly TelemetryEvent[] {
    return structuredClone(this.records);
  }
}

export class FileTelemetrySink implements TelemetrySink {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  async append(event: TelemetryEvent): Promise<void> {
    const parsed = TelemetryEventSchema.parse(structuredClone(event));
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    await appendFile(this.path, `${JSON.stringify(parsed)}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  async list(): Promise<readonly TelemetryEvent[]> {
    const content = await readFile(this.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return content.split(/\r?\n/).filter(Boolean)
      .map((line) => TelemetryEventSchema.parse(JSON.parse(line) as unknown));
  }
}

export async function recordRunTelemetry(
  sink: TelemetrySink,
  snapshot: RunSnapshot,
  input: {
    kind: TelemetryEvent['kind'];
    reasonCode?: TelemetryEvent['reasonCode'];
    latencyMs?: number;
  },
): Promise<TelemetryEvent> {
  const attempts = Object.values(snapshot.attempts);
  const artifactCount = attempts.reduce((count, attempt) => count + (attempt.artifacts?.length ?? 0), 0);
  const event = TelemetryEventSchema.parse({
    eventId: `${snapshot.runId}:telemetry:${input.kind}:${snapshot.lastSeq}:${Date.now()}`,
    at: new Date().toISOString(),
    kind: input.kind,
    runId: snapshot.runId,
    contractId: snapshot.contractId,
    contractVersion: snapshot.contractVersion,
    domain: snapshot.domain,
    mission: snapshot.mission,
    status: snapshot.status,
    lastSeq: snapshot.lastSeq,
    totalCostUsd: snapshot.totalCostUsd,
    completedPhaseCount: snapshot.completedPhases.length,
    attemptCount: attempts.length,
    artifactCount,
    ...(snapshot.inputManifest ? {
      inputRevision: snapshot.inputManifest.inputRevision,
      contextEpoch: snapshot.inputManifest.contextEpoch,
    } : {}),
    ...(input.latencyMs === undefined ? {} : { latencyMs: input.latencyMs }),
    ...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
  });
  await sink.append(event);
  return event;
}
