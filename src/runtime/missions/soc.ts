import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { createArtifactRef } from '../contracts/result-contract.js';
import type {
  SocAuthorizationContext,
  SocPreparedSnapshot,
  SocPreparedSnapshotUnsigned,
  SocSubjectType,
} from '../contracts/soc-schemas.js';
import { SocInvestigationDomainAdapter, SocReportDomainAdapter } from '../domains/soc.js';
import { AnthropicAgentRuntime, type AnthropicPhaseOptions } from '../providers/anthropic-agent-sdk.js';
import { runSession, type SessionOutcome, type SessionSpec } from '../session.js';
import {
  compileSocInvestigationQueryPlan,
  assertSnapshotMatchesPlan,
  materializeSocPreparedSnapshot,
  type SocSourceAdapter,
} from '../soc-source.js';
import { WorkflowHost } from '../workflow/engine.js';
import type { RunLeaseBackend } from '../workflow/run-lease.js';
import { createMissionRuntime, type MissionRuntimeOptions } from '../workflow/mission-runtime.js';
import type { SocRedactionTrustStore } from '../soc-redaction.js';
import { ModelIndependenceGuard } from '../workflow/model-independence.js';

type CommonSocInput = {
  authorization: SocAuthorizationContext;
  engagementId?: string;
  engagementDir?: string;
  scope?: string;
  model?: string;
  reviewModel?: string;
  effort?: SessionSpec['effort'];
  maxTurns?: number;
};

export type SocReportInput = CommonSocInput & {
  snapshot: SocPreparedSnapshot | SocPreparedSnapshotUnsigned;
};

export type SocInvestigationInput = CommonSocInput & {
  subjects: Array<{ type: SocSubjectType; value: string }>;
  timeFrom: string;
  timeTo: string;
  providerSchema: { name: string; version: string; adapterVersion: string };
  maxPages?: number;
  maxRows?: number;
};

export type SocMissionDependencies = {
  redactionTrust: SocRedactionTrustStore;
  sessionRunner?: typeof runSession;
  leaseBackend?: RunLeaseBackend;
  workerId?: string;
  now?: Date;
  runtime?: MissionRuntimeOptions;
};

export type SocMissionResult = {
  status: 'draft' | 'held';
  mission: 'report' | 'investigation';
  engagementDir: string;
  snapshot: SocPreparedSnapshot;
  phases: Array<{ phase: string; role: string; result: unknown; outcome: SessionOutcome }>;
  outcome: SessionOutcome;
  draftPath: string;
};

export async function socReport(
  input: SocReportInput,
  dependencies: SocMissionDependencies,
): Promise<SocMissionResult> {
  const now = dependencies.now ?? new Date();
  const engagementId = input.engagementId ?? makeSocEngagementId('report', now);
  const engagementDir = prepareEngagement(input.engagementDir, engagementId);
  const materialized = materializeSocPreparedSnapshot({
    value: input.snapshot,
    mission: 'report',
    authorization: input.authorization,
    engagementDir,
    redactionTrust: dependencies.redactionTrust,
  });
  return executeSocMission({
    mission: 'report',
    input,
    dependencies,
    engagementId,
    engagementDir,
    snapshot: materialized.snapshot,
    snapshotPath: materialized.path,
    snapshotBytes: materialized.bytes,
  });
}

export async function socInvestigation(
  input: SocInvestigationInput,
  source: SocSourceAdapter,
  dependencies: SocMissionDependencies,
): Promise<SocMissionResult> {
  const now = dependencies.now ?? new Date();
  const engagementId = input.engagementId ?? makeSocEngagementId('investigation', now);
  const engagementDir = prepareEngagement(input.engagementDir, engagementId);
  const plan = compileSocInvestigationQueryPlan({
    authorization: input.authorization,
    subjects: input.subjects,
    timeFrom: input.timeFrom,
    timeTo: input.timeTo,
    providerSchema: input.providerSchema,
    ...(input.maxPages !== undefined ? { maxPages: input.maxPages } : {}),
    ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
  });
  const collected = await source.collect(plan, input.authorization);
  assertSnapshotMatchesPlan(collected, plan);
  const materialized = materializeSocPreparedSnapshot({
    value: collected,
    mission: 'investigation',
    authorization: input.authorization,
    engagementDir,
    redactionTrust: dependencies.redactionTrust,
  });
  return executeSocMission({
    mission: 'investigation',
    input,
    dependencies,
    engagementId,
    engagementDir,
    snapshot: materialized.snapshot,
    snapshotPath: materialized.path,
    snapshotBytes: materialized.bytes,
  });
}

export function makeSocEngagementId(mission: 'report' | 'investigation', now: Date): string {
  return `soc_${mission}_${now.toISOString().replace(/[-:.]/g, '')}`;
}

async function executeSocMission(input: {
  mission: 'report' | 'investigation';
  input: CommonSocInput;
  dependencies: SocMissionDependencies;
  engagementId: string;
  engagementDir: string;
  snapshot: SocPreparedSnapshot;
  snapshotPath: string;
  snapshotBytes: number;
}): Promise<SocMissionResult> {
  const adapter = input.mission === 'report'
    ? new SocReportDomainAdapter()
    : new SocInvestigationDomainAdapter();
  const snapshotName = input.mission === 'report'
    ? '01_soc_report_snapshot.json'
    : '01_soc_investigation_snapshot.json';
  const snapshotArtifact = createArtifactRef({
    engagementDir: input.engagementDir,
    name: snapshotName,
    phase: 'input',
    role: 'host',
    attempt: '0',
    schemaId: 'nunchi.soc.prepared-snapshot.v1',
  });
  const missionRuntime = await createMissionRuntime({
    engagementDir: input.engagementDir,
    runId: input.engagementId,
    contractId: adapter.contract.id,
    contractVersion: adapter.contract.version,
    domain: 'soc',
    mission: input.mission,
  }, {
    ...input.dependencies.runtime,
    ...(input.dependencies.workerId ? { workerId: input.dependencies.workerId } : {}),
  });
  const state = missionRuntime.state;
  try {
  const primaryModel = input.input.model ?? 'opus';
  const reviewModel = input.input.reviewModel ?? 'sonnet';
  if (primaryModel === reviewModel) {
    throw new Error('SOC primary model과 review model은 달라야 한다');
  }
  await missionRuntime.append({
    type: 'input.recorded',
    eventId: `${input.engagementId}:input-recorded`,
    input: {
      inputRevision: 0,
      contextEpoch: input.snapshot.snapshotSha256,
      manifest: snapshotArtifact,
      allowedReadFiles: [input.snapshotPath],
      fileHashes: [{
        path: input.snapshotPath,
        sha256: snapshotArtifact.sha256,
        bytes: input.snapshotBytes,
      }],
    },
  });
  const runtime = new AnthropicAgentRuntime(input.dependencies.sessionRunner ?? runSession);
  const modelGuard = new ModelIndependenceGuard();
  const host = new WorkflowHost({
    adapter,
    runtime,
    state,
    target: dirname(input.engagementDir),
    engagementDir: input.engagementDir,
    runId: input.engagementId,
    allowedReadFiles: [input.snapshotPath],
    scope: input.input.scope,
    ...(missionRuntime.leaseGuard
      ? { leaseGuard: missionRuntime.leaseGuard }
      : input.dependencies.leaseBackend ? { leaseBackend: input.dependencies.leaseBackend } : {}),
    ...(missionRuntime.artifactStore ? { artifactStore: missionRuntime.artifactStore } : {}),
    ...(input.dependencies.workerId ? { workerId: input.dependencies.workerId } : {}),
    outcomePolicy: ({ phase, outcome }) => modelGuard.observe(
      phase === 'evidence-review' || phase === 'verify' ? 'review' : 'primary',
      outcome.usage,
    ),
  });
  const phases: SocMissionResult['phases'] = [];
  const combined: SessionOutcome = { texts: [], ledger: [] };
  const execute = async (id: string, inputArtifacts: string[]) => {
    const model = id === 'evidence-review' || id === 'verify' ? reviewModel : primaryModel;
    const hosted = await host.executePhase({
      id,
      inputs: { inputArtifacts },
      providerOptions: {
        model,
        effort: input.input.effort,
        maxTurns: input.input.maxTurns,
      } satisfies AnthropicPhaseOptions,
    });
    const outcome = hosted.outcome.raw;
    phases.push({ phase: hosted.phase, role: hosted.role, result: hosted.result, outcome });
    mergeOutcome(combined, outcome, hosted.result);
    return hosted;
  };

  const evidence = await execute('evidence-review', []);
  const candidate = input.mission === 'report'
    ? await execute('judge', evidence.result.artifacts)
    : await execute('analyze', evidence.result.artifacts);
  const verified = await execute('verify', [...evidence.result.artifacts, ...candidate.result.artifacts]);
  const status = verified.result.gateDecision === 'pass' ? 'draft' : 'held';
  if (status === 'draft') {
    await missionRuntime.append({ type: 'run.completed', eventId: `${input.engagementId}:completed` }, {
      outbox: [{
        id: `${input.engagementId}:run-completed`,
        idempotencyKey: `${input.engagementId}:run-completed`,
        topic: 'run.completed',
        payload: { runId: input.engagementId, contractId: adapter.contract.id, status },
      }],
    });
  } else {
    await missionRuntime.append({
      type: 'run.blocked',
      eventId: `${input.engagementId}:review-held`,
      reason: `${input.mission} reviewer가 내부 draft를 hold 상태로 분류했다`,
    });
  }
  const draftName = input.mission === 'report'
    ? '05_soc_report_draft.md'
    : '05_soc_investigation_draft.md';
  return {
    status,
    mission: input.mission,
    engagementDir: input.engagementDir,
    snapshot: input.snapshot,
    phases,
    outcome: combined,
    draftPath: join(input.engagementDir, draftName),
  };
  } finally {
    await missionRuntime.close();
  }
}

function prepareEngagement(requested: string | undefined, engagementId: string): string {
  const engagementDir = resolve(requested ?? join(process.cwd(), '.nunchi', 'soc', engagementId));
  if (existsSync(engagementDir) && readdirSync(engagementDir).length > 0) {
    throw new Error(`기존 SOC engagement를 덮어쓸 수 없다: ${engagementDir}`);
  }
  mkdirSync(engagementDir, { recursive: true, mode: 0o700 });
  return engagementDir;
}

function mergeOutcome(combined: SessionOutcome, outcome: SessionOutcome, result: unknown): void {
  combined.texts.push(...outcome.texts);
  combined.ledger.push(...outcome.ledger);
  combined.numTurns = (combined.numTurns ?? 0) + (outcome.numTurns ?? 0);
  combined.totalCostUsd = (combined.totalCostUsd ?? 0) + (outcome.totalCostUsd ?? 0);
  combined.subtype = outcome.subtype;
  combined.modelUsage = [...((combined.modelUsage as unknown[] | undefined) ?? []), outcome.modelUsage];
  combined.registeredAgents = outcome.registeredAgents ?? combined.registeredAgents;
  combined.structuredOutput = result;
}
