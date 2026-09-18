import type {
  HostInputRecord,
  NewRunEvent,
  RunStateBackend,
  RunSnapshot,
} from './state-store.js';
import { recordRunTelemetry, type TelemetryEvent, type TelemetrySink } from './telemetry.js';

export type IncompleteAttempt = {
  phase: string;
  round?: string;
  attempt: number;
  status: 'started' | 'received';
};

export type RunInspection = {
  runId: string;
  contractId: string;
  contractVersion: string;
  domain: string;
  mission: string;
  status: RunSnapshot['status'];
  lastSeq: number;
  totalCostUsd: number;
  completedPhases: string[];
  incompleteAttempts: IncompleteAttempt[];
  inputRevision?: number;
  contextEpoch?: string;
  awaitingInputArtifactSha256?: string;
  publicationArtifactSha256?: string;
};

export type ReconcileReasonCode = 'provider-error' | 'accounting-incomplete' | 'lease-lost' | 'unknown';

export async function inspectRun(state: RunStateBackend): Promise<RunInspection> {
  const snapshot = await state.read();
  const incompleteAttempts = Object.values(snapshot.attempts)
    .flatMap((attempt): IncompleteAttempt[] => {
      if (attempt.status !== 'started' && attempt.status !== 'received') return [];
      return [{
        phase: attempt.phase,
        ...(attempt.round ? { round: attempt.round } : {}),
        attempt: attempt.attempt,
        status: attempt.status,
      }];
    })
    .sort((left, right) => `${left.phase}:${left.round ?? '-'}:${left.attempt}`.localeCompare(
      `${right.phase}:${right.round ?? '-'}:${right.attempt}`,
    ));
  return {
    runId: snapshot.runId,
    contractId: snapshot.contractId,
    contractVersion: snapshot.contractVersion,
    domain: snapshot.domain,
    mission: snapshot.mission,
    status: snapshot.status,
    lastSeq: snapshot.lastSeq,
    totalCostUsd: snapshot.totalCostUsd,
    completedPhases: [...snapshot.completedPhases],
    incompleteAttempts,
    ...(snapshot.inputManifest ? {
      inputRevision: snapshot.inputManifest.inputRevision,
      contextEpoch: snapshot.inputManifest.contextEpoch,
    } : {}),
    ...(snapshot.awaitingInput ? { awaitingInputArtifactSha256: snapshot.awaitingInput.artifact.sha256 } : {}),
    ...(snapshot.publication ? { publicationArtifactSha256: snapshot.publication.artifact.sha256 } : {}),
  };
}

export async function reconcileIncompleteAttempt(input: {
  state: RunStateBackend;
  expectedVersion: number;
  phase: string;
  round?: string;
  attempt: number;
  reasonCode: ReconcileReasonCode;
  fencingToken?: number;
  telemetry?: TelemetrySink;
}): Promise<Readonly<RunSnapshot>> {
  const snapshot = await input.state.read();
  assertExpectedVersion(snapshot, input.expectedVersion);
  const key = `${input.phase}:${input.round ?? '-'}:${input.attempt}`;
  const current = snapshot.attempts[key];
  if (!current || (current.status !== 'started' && current.status !== 'received')) {
    throw new Error(`reconcile 대상 incomplete attempt가 아니다: ${key}`);
  }
  const event: NewRunEvent = {
    type: 'phase.failed',
    eventId: `${snapshot.runId}:reconcile:${key}:${input.reasonCode}`,
    phase: input.phase,
    ...(input.round ? { round: input.round } : {}),
    attempt: input.attempt,
    reason: `operator-reconcile:${input.reasonCode}`,
  };
  const next = await appendBatch(input.state, [event], input.expectedVersion, input.fencingToken);
  if (input.telemetry) {
    await recordRunTelemetry(input.telemetry, next, { kind: 'reconcile', reasonCode: 'reconciled' });
  }
  return next;
}

export async function resumeRunWithInput(input: {
  state: RunStateBackend;
  expectedVersion: number;
  revisedInput: HostInputRecord;
  fencingToken?: number;
  telemetry?: TelemetrySink;
}): Promise<Readonly<RunSnapshot>> {
  const snapshot = await input.state.read();
  assertExpectedVersion(snapshot, input.expectedVersion);
  if (snapshot.status !== 'awaiting-input' || !snapshot.inputManifest || !snapshot.awaitingInput) {
    throw new Error('resume 대상 run이 awaiting-input 상태가 아니다');
  }
  const expectedRevision = snapshot.inputManifest.inputRevision + 1;
  if (input.revisedInput.inputRevision !== expectedRevision) {
    throw new Error(`resume input revision 충돌: ${input.revisedInput.inputRevision} != ${expectedRevision}`);
  }
  if (!input.revisedInput.parent
    || input.revisedInput.parent.manifestSha256 !== snapshot.inputManifest.manifest.sha256
    || input.revisedInput.parent.triggerArtifactSha256 !== snapshot.awaitingInput.artifact.sha256) {
    throw new Error('resume input lineage가 awaiting-input 상태와 다르다');
  }
  const events: NewRunEvent[] = [
    {
      type: 'input.revised',
      eventId: `${snapshot.runId}:reconcile:input-revised:${expectedRevision}`,
      input: input.revisedInput,
    },
    {
      type: 'run.resumed',
      eventId: `${snapshot.runId}:reconcile:resumed:${expectedRevision}`,
    },
  ];
  const next = await appendBatch(input.state, events, input.expectedVersion, input.fencingToken);
  if (input.telemetry) {
    await recordRunTelemetry(input.telemetry, next, { kind: 'resume' });
  }
  return next;
}

async function appendBatch(
  state: RunStateBackend,
  events: readonly NewRunEvent[],
  expectedVersion: number,
  fencingToken?: number,
): Promise<Readonly<RunSnapshot>> {
  if (state.backend === 'postgres') {
    if (fencingToken === undefined) throw new Error('PostgreSQL reconcile에는 fencing token이 필요하다');
    return await state.appendBatch(events, expectedVersion, fencingToken);
  }
  return state.appendBatch(events, expectedVersion);
}

function assertExpectedVersion(snapshot: RunSnapshot, expectedVersion: number): void {
  if (snapshot.lastSeq !== expectedVersion) {
    throw new Error(`reconcile version 충돌: ${expectedVersion} != ${snapshot.lastSeq}`);
  }
}

export type { TelemetryEvent };
