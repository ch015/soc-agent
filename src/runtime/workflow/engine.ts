import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  assertWorkflowPrerequisites,
  type ProviderCapability,
} from '../contracts/workflow-contract.js';
import {
  createArtifactRef,
  parsePhaseResultEnvelope,
  verifyRunArtifactRef,
  type ArtifactRef,
  type PhaseResultEnvelope,
} from '../contracts/result-contract.js';
import type { DomainAdapter, ValidationOutcome } from '../domains/domain-adapter.js';
import {
  assertProviderCapabilities,
  ProviderRuntimeFailure,
  type ProviderPhaseOutcome,
  type ProviderRuntimeEvent,
  type ProviderRuntime,
} from '../providers/provider-runtime.js';
import {
  phaseAttemptKey,
  type NewRunEvent,
  type HostResourceReceipt,
  type RunStateBackend,
  type RunStateEffects,
  type RunSnapshot,
} from './state-store.js';
import { assertStrategyExecutable, assertStrategySupported } from './strategies.js';
import { AutoRenewingRunLease, type RunLeaseBackend } from './run-lease.js';
import type { ImmutableArtifactStore, ArtifactReceipt } from './artifact-store.js';
import {
  assertHostResourceReceipts,
  assertRunInputsIntact,
  loadHostResources,
  receiptsOnly,
  renderHostResources,
  sameSet,
  type LoadedHostResource,
} from './host-integrity.js';
import { buildPhaseMetrics, emitPhaseMetrics } from './phase-metrics.js';
import {
  checkCostGuard,
  createCostAccumulator,
  parseCostGuardPolicy,
  recordPhaseAttempt,
  type CostAccumulator,
  type CostGuardPolicy,
} from './cost-guard.js';

export type WorkflowPhaseExecution<TResult, TRaw> = {
  phase: string;
  role: string;
  round?: string;
  attempt: number;
  result: TResult;
  artifacts: ArtifactRef[];
  envelope: PhaseResultEnvelope;
  outcome: ProviderPhaseOutcome<TRaw>;
};

type ResultIdentity = {
  workUnitKey: string;
  workPlanSha256: string;
  assignedSourceSha256: string;
};

type ProviderIdentityDisposition = 'absent' | 'matched' | 'overridden';

const RETRY_SANITIZE_PATTERNS = [
  /\[SYSTEM\]/gi,
  /<\|im_start\|>/gi,
  /<\|im_end\|>/gi,
  /<\/?instructions?>/gi,
  /<\/?system(?:-[a-z]+)?>/gi,
  /<\/?anthropic>/gi,
  /Human:\s*\n/gi,
  /Assistant:\s*\n/gi,
];

function sanitizeRetryError(message: string): string {
  let out = message.slice(0, 500);
  for (const p of RETRY_SANITIZE_PATTERNS) out = out.replace(p, '[FILTERED]');
  return out;
}

function extractTokenUsage(raw: unknown): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  for (const entry of Object.values(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.inputTokens === 'number') inputTokens += record.inputTokens;
    if (typeof record.outputTokens === 'number') outputTokens += record.outputTokens;
    if (typeof record.cacheReadInputTokens === 'number') cacheReadInputTokens += record.cacheReadInputTokens;
  }
  return { inputTokens, outputTokens, cacheReadInputTokens };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isExactResultIdentity(value: unknown, expected: ResultIdentity): boolean {
  if (!isPlainRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const expectedKeys = ['assignedSourceSha256', 'workPlanSha256', 'workUnitKey'];
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index])
    && value.workUnitKey === expected.workUnitKey
    && value.workPlanSha256 === expected.workPlanSha256
    && value.assignedSourceSha256 === expected.assignedSourceSha256;
}

function bindResultIdentity(value: unknown, expected: ResultIdentity): {
  value: Record<string, unknown>;
  disposition: ProviderIdentityDisposition;
} {
  if (!isPlainRecord(value)) {
    throw new Error('work unit provider structured output이 plain object가 아니다');
  }
  const hasIdentity = Object.prototype.hasOwnProperty.call(value, 'workUnit');
  const disposition: ProviderIdentityDisposition = !hasIdentity
    ? 'absent'
    : isExactResultIdentity(value.workUnit, expected)
      ? 'matched'
      : 'overridden';
  return {
    value: { ...value, workUnit: { ...expected } },
    disposition,
  };
}

/**
 * M10: Thrown by validatePhaseResult when validateResultV2 returns 'retry'.
 * Always eligible for retry regardless of message content.
 */
export class ValidationRetryError extends Error {
  readonly retryable = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationRetryError';
  }
}

/**
 * M10: Thrown by validatePhaseResult when validateResultV2 returns 'safety-fail'.
 * Never eligible for retry — must immediately halt the run.
 */
export class ValidationSafetyError extends Error {
  readonly safetyFail = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationSafetyError';
  }
}

export class WorkflowHost<
  TLegacyContract,
  TLegacyPhase,
  TResult extends { artifacts: string[]; status?: string; unresolved?: string[] },
  TProviderOptions,
  TRaw,
> {
  constructor(
    private readonly input: {
      adapter: DomainAdapter<TLegacyContract, TLegacyPhase, TResult>;
      runtime: ProviderRuntime<TProviderOptions, TRaw>;
      state: RunStateBackend;
      target: string;
      engagementDir: string;
      runRoot?: string;
      runId: string;
      hostEntrypoint?: string;
      leaseBackend?: RunLeaseBackend;
      leaseGuard?: { assertActive(): Promise<void>; fencingToken?(): number };
      workerId?: string;
      leaseTtlMs?: number;
      scope?: string;
      allowedReadFiles?: readonly string[];
      onEvent?: (event: ProviderRuntimeEvent) => void;
      artifactStore?: ImmutableArtifactStore;
      outcomePolicy?: (input: {
        phase: string;
        role: string;
        outcome: ProviderPhaseOutcome<TRaw>;
      }) => void;
      costGuardPolicy?: CostGuardPolicy;
    },
  ) {
    if (input.leaseBackend && input.leaseGuard) {
      throw new Error('workflow host에는 lease backend와 external guard를 동시에 지정할 수 없다');
    }
    if (input.state.backend === 'postgres' && (!input.leaseGuard || !input.artifactStore)) {
      throw new Error('PostgreSQL workflow host에는 외부 lease guard와 immutable artifact store가 필요하다');
    }
    const hostExecution = input.adapter.contract.hostExecution;
    if (
      hostExecution?.directPhaseExecution === 'forbidden' &&
      input.hostEntrypoint !== hostExecution.entrypoint
    ) {
      throw new Error(`${input.adapter.contract.id} phase는 ${hostExecution.entrypoint} host entrypoint로만 실행할 수 있다`);
    }
  }

  async executePhase(options: {
    id: string;
    round?: string;
    inputs?: Record<string, unknown>;
    providerOptions?: TProviderOptions;
    priorArtifactPaths?: readonly string[];
    deferRunBlocking?: boolean;
    resultIdentity?: {
      workUnitKey: string;
      workPlanSha256: string;
      assignedSourceSha256: string;
    };
  }): Promise<WorkflowPhaseExecution<TResult, TRaw>> {
    const ownedLease = this.input.leaseBackend
      ? await AutoRenewingRunLease.acquire(this.input.leaseBackend, {
          runId: this.input.runId,
          ownerId: this.input.workerId ?? `worker-${process.pid}`,
          ttlMs: this.input.leaseTtlMs ?? 1_800_000,
        })
      : undefined;
    const lease = this.input.leaseGuard ?? ownedLease;
    try {
    if (lease) await lease.assertActive();
    const { workflow, legacy } = this.input.adapter.getPhase(options.id);
    assertStrategySupported(this.input.adapter.contract, workflow, this.input.runtime);
    assertStrategyExecutable(workflow);
    if (workflow.approvals.length > 0) {
      throw new Error(`${workflow.id} approval broker는 아직 등록되지 않았다`);
    }
    const snapshot = await this.readState();
    this.assertStateIdentity(snapshot);
    assertRunInputsIntact(snapshot, this.input.runRoot ?? this.input.engagementDir);
    const completed = new Set(
      Object.values(snapshot.attempts)
        .filter((attempt) => attempt.status === 'completed')
        .map((attempt) => attempt.phase),
    );
    assertWorkflowPrerequisites(workflow, completed);
    let remainingBudget = snapshot.maxBudgetUsd === undefined
      ? undefined
      : snapshot.maxBudgetUsd - snapshot.totalCostUsd;
    if (remainingBudget !== undefined && remainingBudget <= 0) {
      if (lease) await lease.assertActive();
      await this.appendState({
        type: 'run.blocked',
        eventId: `${this.input.runId}:budget-exhausted`,
        reason: `전체 예산을 소진해 ${workflow.id} phase를 시작할 수 없다`,
      }, lease);
      throw new Error(`전체 예산을 소진해 ${workflow.id} phase를 시작할 수 없다`);
    }

    const maxRetryAttempts = this.getMaxRetryAttempts();
    let retryContext: { previousError: string; attempt: number } | undefined;
    const costAccumulator = createCostAccumulator(snapshot.totalCostUsd);

    for (let attemptNum = 1; attemptNum <= maxRetryAttempts; attemptNum++) {
    // Recompute after every charged attempt; retries share the run budget.
    if (snapshot.maxBudgetUsd !== undefined) {
      remainingBudget = snapshot.maxBudgetUsd - (await this.readState()).totalCostUsd;
      if (remainingBudget <= 0) {
        if (lease) await lease.assertActive();
        await this.appendState({ type: 'run.blocked', eventId: `${this.input.runId}:budget-exhausted`,
          reason: `전체 예산을 소진해 ${workflow.id} 재시도를 시작할 수 없다` }, lease);
        throw new Error(`전체 예산을 소진해 ${workflow.id} 재시도를 시작할 수 없다`);
      }
    }

    // M11: CostGuard pre-attempt check
    if (this.input.costGuardPolicy) {
      const guardDecision = checkCostGuard(this.input.costGuardPolicy, costAccumulator);
      if (!guardDecision.allowed) {
        throw new Error(`CostGuard가 phase ${workflow.id} attempt를 차단했다: ${guardDecision.reason}`);
      }
    }
    const attempt = await this.nextAttempt(workflow.id, options.round);
    const attemptKey = phaseAttemptKey(workflow.id, options.round, attempt);
    let hostResources: LoadedHostResource[];
    try {
      hostResources = loadHostResources(this.input.adapter.hostPromptResources?.(legacy) ?? []);
    } catch (error) {
      if (lease) await lease.assertActive();
      await this.appendState({
        type: 'run.blocked',
        eventId: `${this.input.runId}:${attemptKey}:host-resource-load-failed`,
        reason: `${workflow.id} host contract resource를 읽지 못했다`,
      }, lease);
      throw error;
    }
    if (lease) await lease.assertActive();
    await this.appendState({
      type: 'phase.started',
      eventId: `${this.input.runId}:${attemptKey}:started`,
      phase: workflow.id,
      ...(options.round ? { round: options.round } : {}),
      attempt,
      ...(hostResources.length > 0 ? { hostResources: receiptsOnly(hostResources) } : {}),
    }, lease);

    const phaseStartTime = Date.now();
    try {
      const requiredCapabilities = this.requiredCapabilities(workflow.role);
      assertProviderCapabilities(this.input.runtime, requiredCapabilities);
      const currentSnapshot = await this.readState();
      const completedArtifactRefs = Object.values(currentSnapshot.attempts)
        .filter((candidate) => candidate.status === 'completed')
        .flatMap((candidate) => candidate.artifacts ?? [])
        .filter((artifact) => dirname(resolve(artifact.path)) === resolve(this.input.engagementDir));
      const selectedNames = this.input.adapter.allowedPriorArtifacts?.(legacy, options.inputs);
      const priorArtifacts = options.priorArtifactPaths !== undefined
        ? this.selectExactPriorArtifactPaths(options.priorArtifactPaths, completedArtifactRefs)
        : selectedNames === undefined
          ? completedArtifactRefs.map((artifact) => artifact.path)
          : this.selectExactPriorArtifacts(selectedNames, completedArtifactRefs);
      const allowedReadFiles = [...new Set([
        ...(this.input.allowedReadFiles ?? []),
        ...(currentSnapshot.inputManifest?.allowedReadFiles ?? []),
        ...priorArtifacts,
      ])];
      const basePrompt = [
        this.input.adapter.buildPrompt({
          phase: legacy,
          target: this.input.target,
          engagementDir: this.input.engagementDir,
          runId: this.input.runId,
          attempt: attemptKey,
          scope: this.input.scope,
          round: options.round,
          inputs: options.inputs,
        }),
        renderHostResources(hostResources),
      ].filter(Boolean).join('\n\n');
      const prompt = retryContext
        ? `${basePrompt}\n\n--- Retry context (attempt ${retryContext.attempt}) ---\nPrevious output failed validation: ${sanitizeRetryError(retryContext.previousError)}. Correct the output to satisfy validation requirements.`
        : basePrompt;
      const outcome = await this.input.runtime.runPhase({
        contractId: this.input.adapter.contract.id,
        contractVersion: this.input.adapter.contract.version,
        domain: this.input.adapter.domain,
        mission: this.input.adapter.mission,
        phase: workflow.id,
        role: workflow.role,
        runId: this.input.runId,
        attempt: attemptKey,
        target: this.input.target,
        engagementDir: this.input.engagementDir,
        prompt,
        requiredCapabilities,
        ...(remainingBudget !== undefined ? { maxBudgetUsd: remainingBudget } : {}),
        ...(allowedReadFiles.length > 0 ? { allowedReadFiles } : {}),
        options: options.providerOptions,
        onEvent: this.input.onEvent,
      });

      if (lease) await lease.assertActive();
      await this.appendCompactionEvents(outcome.events, {
        phase: workflow.id,
        round: options.round,
        attempt,
        attemptKey,
        provider: outcome.provider,
      }, lease);
      await this.appendState({
        type: 'attempt.received',
        eventId: `${this.input.runId}:${attemptKey}:receipt`,
        phase: workflow.id,
        ...(options.round ? { round: options.round } : {}),
        attempt,
        usage: outcome.usage,
      }, lease);
      // M11: Record attempt cost/tokens for CostGuard accumulator
      const usageForCost = extractTokenUsage(outcome.usage.raw);
      recordPhaseAttempt(
        costAccumulator,
        outcome.usage.costUsd ?? 0,
        (usageForCost.inputTokens ?? 0) + (usageForCost.outputTokens ?? 0),
      );
      this.input.outcomePolicy?.({ phase: workflow.id, role: workflow.role, outcome });
      assertHostResourceReceipts(hostResources);
      this.assertMethodsLoaded(legacy, outcome, hostResources);
      let resultValue = outcome.structuredOutput;
      let identityDisposition: ProviderIdentityDisposition | undefined;
      if (options.resultIdentity) {
        const bound = bindResultIdentity(resultValue, options.resultIdentity);
        resultValue = bound.value;
        identityDisposition = bound.disposition;
        await this.appendState({
          type: 'phase.result-identity-bound',
          eventId: `${this.input.runId}:${attemptKey}:result-identity-bound`,
          phase: workflow.id,
          ...(options.round ? { round: options.round } : {}),
          attempt,
          source: 'host',
          providerIdentity: identityDisposition,
          provider: outcome.provider,
        }, lease);
      }
      const result = this.validatePhaseResult(resultValue, legacy, options.round, attemptNum, maxRetryAttempts);
      this.assertArtifactContract(workflow, legacy, options.round, result.artifacts);
      const artifacts = result.artifacts.map((name) =>
        createArtifactRef({
          engagementDir: this.input.engagementDir,
          name,
          phase: workflow.id,
          role: this.input.adapter.hostOwnedArtifacts?.(legacy, options.round)?.includes(name)
            ? 'host'
            : workflow.role,
          attempt: attemptKey,
        }),
      );
      const envelope = parsePhaseResultEnvelope({
        value: {
          contractId: this.input.adapter.contract.id,
          contractVersion: this.input.adapter.contract.version,
          runId: this.input.runId,
          phase: workflow.id,
          role: workflow.role,
          attempt: attemptKey,
          status: result.status === 'blocked' ? 'blocked' : 'complete',
          artifacts,
          decisions: [],
          domainPayload: result,
          unresolved: result.unresolved ?? [],
          usage: outcome.usage,
        },
        identity: {
          contractId: this.input.adapter.contract.id,
          contractVersion: this.input.adapter.contract.version,
          runId: this.input.runId,
          phase: workflow.id,
          role: workflow.role,
          attempt: attemptKey,
        },
      });
      if (envelope.status === 'blocked') {
        throw new Error(`${workflow.id} phase가 blocked 상태다: ${envelope.unresolved.join(', ')}`);
      }
      if (lease) await lease.assertActive();
      const artifactReceipts = await this.persistArtifacts(artifacts);
      await this.appendState({
        type: 'phase.completed',
        eventId: `${this.input.runId}:${attemptKey}:completed`,
        phase: workflow.id,
        ...(options.round ? { round: options.round } : {}),
        attempt,
        artifacts,
        result: { envelope, domainResult: result },
        ...(hostResources.length > 0 ? { hostResources: receiptsOnly(hostResources) } : {}),
      }, lease, {
        artifactReceipts,
        outbox: [{
          id: `${this.input.runId}:${attemptKey}:phase-completed`,
          idempotencyKey: `${this.input.runId}:${attemptKey}:phase-completed`,
          topic: 'run.phase.completed',
          payload: {
            runId: this.input.runId,
            contractId: this.input.adapter.contract.id,
            phase: workflow.id,
            attempt: attemptKey,
            artifactHashes: artifacts.map((artifact) => artifact.sha256),
          },
        }],
      });
      emitPhaseMetrics(buildPhaseMetrics({
        runId: this.input.runId,
        domain: this.input.adapter.domain,
        phase: workflow.id,
        agent: workflow.role,
        attempt,
        usage: extractTokenUsage(outcome.usage.raw),
        startTime: phaseStartTime,
        validationPassed: true,
        qualityIssueCount: 0,
        costUsd: outcome.usage.costUsd,
      }));
      return {
        phase: workflow.id,
        role: workflow.role,
        ...(options.round ? { round: options.round } : {}),
        attempt,
        result,
        artifacts,
        envelope,
        outcome,
      };
    } catch (error) {
      // M6a: retry on validation failure (not ProviderRuntimeFailure, not host integrity errors)
      if (
        attemptNum < maxRetryAttempts &&
        this.isRetryEnabled() &&
        this.shouldRetryValidation(error)
      ) {
        // Record the failed attempt before retrying
        if (lease) await lease.assertActive();
        const current = (await this.readState()).attempts[attemptKey];
        if (current && current.status !== 'failed' && current.status !== 'completed') {
          await this.appendState({
            type: 'phase.failed',
            eventId: `${this.input.runId}:${attemptKey}:failed`,
            phase: workflow.id,
            ...(options.round ? { round: options.round } : {}),
            attempt,
            reason: error instanceof Error ? error.message : String(error),
          }, lease);
        }
        retryContext = {
          previousError: error instanceof Error ? error.message : String(error),
          attempt: attemptNum,
        };
        continue;
      }

      if (lease) await lease.assertActive();
      if (error instanceof ProviderRuntimeFailure) {
        await this.appendCompactionEvents(error.events, {
          phase: workflow.id,
          round: options.round,
          attempt,
          attemptKey,
          provider: error.usage?.provider ?? this.input.runtime.name,
        }, lease);
      }
      const accountingIncomplete =
        error instanceof ProviderRuntimeFailure && error.usage?.accountingComplete === false;
      let current = (await this.readState()).attempts[attemptKey];
      if (error instanceof ProviderRuntimeFailure && error.usage && current?.status === 'started') {
        await this.appendState({
          type: 'attempt.received',
          eventId: `${this.input.runId}:${attemptKey}:receipt`,
          phase: workflow.id,
          ...(options.round ? { round: options.round } : {}),
          attempt,
          usage: error.usage,
        }, lease);
        current = (await this.readState()).attempts[attemptKey];
      }
      if (current && current.status !== 'failed' && current.status !== 'completed') {
        await this.appendState({
          type: 'phase.failed',
          eventId: `${this.input.runId}:${attemptKey}:failed`,
          phase: workflow.id,
          ...(options.round ? { round: options.round } : {}),
          attempt,
          reason: error instanceof Error ? error.message : String(error),
        }, lease);
      }
      if (accountingIncomplete && !options.deferRunBlocking) {
        // accounting 불완전은 일시적 provider 문제이므로 run을 blocked시키지 않음.
        // phase.failed는 이미 위에서 발행됐으므로 추가 이벤트 없이 경고만 기록.
      } else if (
        !options.deferRunBlocking &&
        this.input.adapter.contract.failurePolicy.validationFailure === 'block'
      ) {
        await this.appendState({
          type: 'run.blocked',
          eventId: `${this.input.runId}:${attemptKey}:validation-blocked`,
          reason: `${workflow.id} phase validation이 실패했다`,
        }, lease);
      }
      const failureUsage = error instanceof ProviderRuntimeFailure ? error.usage : undefined;
      emitPhaseMetrics(buildPhaseMetrics({
        runId: this.input.runId,
        domain: this.input.adapter.domain,
        phase: workflow.id,
        agent: workflow.role,
        attempt,
        usage: extractTokenUsage(failureUsage?.raw),
        startTime: phaseStartTime,
        validationPassed: false,
        qualityIssueCount: 0,
        costUsd: failureUsage?.costUsd ?? 0,
      }));
      throw error;
    }
    } // end retry loop
    // Unreachable — loop always returns or throws
    throw new Error('executePhase retry loop exited without result');
    } finally {
      if (ownedLease) await ownedLease.release();
    }
  }

  /**
   * M6a: Determines if an error is eligible for validation retry.
   * Only adapter.validateResult / adapter.validateAcceptedResult failures qualify.
   * ProviderRuntimeFailure, host integrity assertions, and artifact contract errors do NOT.
   */
  private shouldRetryValidation(error: unknown): boolean {
    if (error instanceof ProviderRuntimeFailure) return false;
    if (!(error instanceof Error)) return false;
    // M10: structured validation signals
    if (error instanceof ValidationRetryError) return true;
    if (error instanceof ValidationSafetyError) return false;
    const message = error.message;
    // Host integrity errors (assertHostResourceReceipts)
    if (message.includes('host contract resource hash') || message.includes('host contract resource path')) return false;
    // Host input integrity errors (assertRunInputsIntact)
    if (message.includes('host input hash path') || message.includes('host input source hash')) return false;
    // Source integrity errors from domain validation
    if (message.includes('source hash가 다르다') || message.includes('source hash')) return false;
    // assertMethodsLoaded errors
    if (message.includes('필수 method file을 로드하지 않았다')) return false;
    // assertArtifactContract errors
    if (message.includes('common/domain artifact 계약이 일치하지 않는다')) return false;
    if (message.includes('계약 밖 artifact다')) return false;
    if (message.includes('필수 artifact가 없다')) return false;
    if (message.includes('artifact가 중복됐다')) return false;
    if (message.includes('artifact에 round가 필요하다')) return false;
    // blocked result error
    if (message.includes('phase가 blocked 상태다')) return false;
    // work unit identity errors
    if (message.includes('plain object가 아니다')) return false;
    // lease errors
    if (message.includes('lease')) return false;
    return true;
  }

  /** M6a: Check if retry is enabled via NUNCHI_RETRY_ENABLED env var (default 'true'). */
  private isRetryEnabled(): boolean {
    return (process.env.NUNCHI_RETRY_ENABLED ?? 'true') !== 'false';
  }

  /** M6a: Get maximum total attempts (1 original + retries). Configurable via contract failurePolicy. */
  private getMaxRetryAttempts(): number {
    const policy = this.input.adapter.contract.failurePolicy;
    if ('maxRetryAttempts' in policy && typeof (policy as Record<string, unknown>).maxRetryAttempts === 'number') {
      return (policy as Record<string, unknown>).maxRetryAttempts as number;
    }
    return 3; // default: 1 original + 2 retries
  }

  /**
   * M10: Unified validation dispatcher.
   * When the adapter implements validateResultV2, uses the structured outcome to decide
   * pass/retry/record-continue/safety-fail. Otherwise falls back to validateResult + validateAcceptedResult.
   * Throws for retry/safety-fail, returns TResult for pass.
   */
  private validatePhaseResult(
    resultValue: unknown,
    legacy: TLegacyPhase,
    round: string | undefined,
    attemptNum: number,
    maxRetryAttempts: number,
  ): TResult {
    if (this.input.adapter.validateResultV2) {
      const outcome: ValidationOutcome<TResult> = this.input.adapter.validateResultV2({
        value: resultValue,
        phase: legacy,
        engagementDir: this.input.engagementDir,
        round,
      });
      switch (outcome.status) {
        case 'pass':
          return outcome.data as TResult;
        case 'retry':
          throw new ValidationRetryError(outcome.error ?? 'validateResultV2 returned retry');
        case 'record-continue':
          // record-continue: return data (possibly partial) so the phase can complete.
          // Emit a quality event so downstream reporting includes the degradation.
          if (!outcome.data) throw new Error('validateResultV2 record-continue에 data가 없다');
          emitPhaseMetrics(buildPhaseMetrics({
            runId: this.input.runId,
            domain: this.input.adapter.domain,
            phase: 'validation-record-continue',
            agent: 'host',
            attempt: 0,
            usage: { inputTokens: 0, outputTokens: 0 },
            startTime: Date.now(),
            validationPassed: false,
            qualityIssueCount: 1,
            costUsd: 0,
          }));
          return outcome.data;
        case 'safety-fail':
          throw new ValidationSafetyError(outcome.error ?? 'validateResultV2 safety failure');
      }
    }
    // Legacy path: call validateResult + validateAcceptedResult (throw-based)
    const result = this.input.adapter.validateResult({
      value: resultValue,
      phase: legacy,
      engagementDir: this.input.engagementDir,
      round,
    });
    this.input.adapter.validateAcceptedResult?.({
      result,
      phase: legacy,
      engagementDir: this.input.engagementDir,
      round,
    });
    return result;
  }

  private requiredCapabilities(role: string): ProviderCapability[] {
    return [...(this.input.adapter.contract.roles[role]?.requiredCapabilities ?? [])];
  }

  private async readState(): Promise<Readonly<RunSnapshot>> {
    return await this.input.state.read();
  }

  private async appendState(
    event: NewRunEvent,
    lease?: { fencingToken?(): number },
    effects: RunStateEffects = {},
  ): Promise<Readonly<RunSnapshot>> {
    if (this.input.state.backend === 'postgres') {
      const expectedLastSeq = (await this.readState()).lastSeq;
      const fencingToken = lease?.fencingToken?.();
      if (fencingToken === undefined) {
        throw new Error('PostgreSQL run state append에는 active fencing token이 필요하다');
      }
      return await this.input.state.appendBatchWithEffects([event], expectedLastSeq, fencingToken, effects);
    }
    return this.input.state.append(event);
  }

  private async appendCompactionEvents(
    events: readonly ProviderRuntimeEvent[],
    input: {
      phase: string;
      round?: string;
      attempt: number;
      attemptKey: string;
      provider: string;
    },
    lease?: { fencingToken?(): number },
  ): Promise<void> {
    const seenBoundaryIds = new Set<string>();
    for (const event of events) {
      const compact = event.compaction;
      if (!compact || seenBoundaryIds.has(compact.boundaryId)) continue;
      seenBoundaryIds.add(compact.boundaryId);
      await this.appendState({
        type: 'phase.context-compacted',
        eventId: `${this.input.runId}:${input.attemptKey}:context-compacted:${compact.boundaryId}`,
        phase: input.phase,
        ...(input.round ? { round: input.round } : {}),
        attempt: input.attempt,
        provider: input.provider,
        trigger: compact.trigger,
        preTokens: compact.preTokens,
        ...(compact.postTokens !== undefined ? { postTokens: compact.postTokens } : {}),
        ...(compact.durationMs !== undefined ? { durationMs: compact.durationMs } : {}),
        boundaryId: compact.boundaryId,
      }, lease);
    }
  }

  private async persistArtifacts(artifacts: readonly ArtifactRef[]): Promise<ArtifactReceipt[]> {
    if (!this.input.artifactStore) return [];
    const receipts: ArtifactReceipt[] = [];
    for (const artifact of artifacts) {
      const runKey = createHash('sha256').update(this.input.runId).digest('hex').slice(0, 32);
      const artifactKey = createHash('sha256').update(artifact.id).digest('hex');
      receipts.push(await this.input.artifactStore.put({
        uri: `artifact://runs/${runKey}/${artifactKey}`,
        content: readFileSync(artifact.path),
        mediaType: artifact.mediaType,
        producer: `${artifact.producer.phase}/${artifact.producer.role}/${artifact.producer.attempt}`,
      }));
    }
    return receipts;
  }

  private assertStateIdentity(snapshot: RunSnapshot): void {
    if (
      snapshot.runId !== this.input.runId ||
      snapshot.contractId !== this.input.adapter.contract.id ||
      snapshot.contractVersion !== this.input.adapter.contract.version ||
      snapshot.domain !== this.input.adapter.domain ||
      snapshot.mission !== this.input.adapter.mission
    ) {
      throw new Error('workflow host와 run state identity가 일치하지 않는다');
    }
  }

  private async nextAttempt(phase: string, round?: string): Promise<number> {
    const attempts = Object.values((await this.readState()).attempts).filter(
      (attempt) => attempt.phase === phase && attempt.round === round,
    );
    const incomplete = attempts.find(
      (attempt) => attempt.status === 'started' || attempt.status === 'received',
    );
    if (incomplete) {
      throw new Error(
        `불완전한 phase attempt는 자동 재실행할 수 없다: ` +
          `${phaseAttemptKey(incomplete.phase, incomplete.round, incomplete.attempt)}`,
      );
    }
    return Math.max(0, ...attempts.map((attempt) => attempt.attempt)) + 1;
  }

  private selectExactPriorArtifacts(
    names: readonly string[],
    completed: readonly ArtifactRef[],
  ): string[] {
    if (new Set(names).size !== names.length) throw new Error('phase prior artifact 이름이 중복됐다');
    const byName = new Map<string, ArtifactRef>();
    for (const artifact of completed) {
      if (byName.has(artifact.name)) throw new Error(`phase prior artifact 이름이 모호하다: ${artifact.name}`);
      byName.set(artifact.name, artifact);
    }
    return names.map((name) => {
      const artifact = byName.get(name);
      if (!artifact) throw new Error(`phase prior artifact가 완료 산출물에 없다: ${name}`);
      return artifact.path;
    });
  }

  private selectExactPriorArtifactPaths(
    paths: readonly string[],
    completed: readonly ArtifactRef[],
  ): string[] {
    const canonical = paths.map((path) => resolve(path));
    if (new Set(canonical).size !== canonical.length) throw new Error('phase prior artifact path가 중복됐다');
    const byPath = new Map(completed.map((artifact) => [resolve(artifact.path), artifact]));
    return canonical.map((path) => {
      const artifact = byPath.get(path);
      if (!artifact) {
        throw new Error(`phase prior artifact path가 완료 산출물에 없다: ${path}`);
      }
      // #8 fix: dirname 제약 제거 — runRoot 하위이면 허용 (cross-attempt 참조 가능)
      // verifyRunArtifact는 항상 호출하여 SHA-256 무결성 + runRoot 경계 검증 유지
      this.verifyRunArtifact(artifact);
      return path;
    });
  }

  private verifyRunArtifact(artifact: ArtifactRef): void {
    verifyRunArtifactRef(artifact, this.input.runRoot ?? this.input.engagementDir);
  }

  private assertArtifactContract(
    phase: { id: string; requiredArtifacts: string[]; optionalArtifacts: string[] },
    legacyPhase: TLegacyPhase,
    round: string | undefined,
    declaredArtifacts: readonly string[],
  ): void {
    const render = (name: string): string => {
      if (name.includes('{round}') && !round) throw new Error(`${phase.id} artifact에 round가 필요하다`);
      return name.replaceAll('{round}', round ?? '');
    };
    const common = {
      required: phase.requiredArtifacts.map(render),
      optional: phase.optionalArtifacts.map(render),
    };
    const domain = this.input.adapter.renderArtifacts(legacyPhase, round);
    if (
      !sameSet(common.required, domain.required) ||
      !sameSet(common.optional, domain.optional)
    ) {
      throw new Error(`${phase.id} common/domain artifact 계약이 일치하지 않는다`);
    }
    const declared = new Set(declaredArtifacts);
    if (declared.size !== declaredArtifacts.length) throw new Error(`${phase.id} artifact가 중복됐다`);
    const allowed = new Set([...common.required, ...common.optional]);
    for (const artifact of declared) {
      if (!allowed.has(artifact)) throw new Error(`${phase.id} 계약 밖 artifact다: ${artifact}`);
    }
    for (const artifact of common.required) {
      if (!declared.has(artifact)) throw new Error(`${phase.id} 필수 artifact가 없다: ${artifact}`);
    }
  }

  private assertMethodsLoaded(
    phase: TLegacyPhase,
    outcome: ProviderPhaseOutcome<TRaw>,
    hostResources: readonly HostResourceReceipt[],
  ): void {
    const loadedMethods = new Set(
      outcome.events
        .filter((event) => event.tool === 'Read' && event.decision === 'allow' && event.resource)
        .map((event) => resolve(this.input.target, event.resource as string)),
    );
    const hostLoaded = new Set(hostResources.map((resource) => resource.path));
    for (const methodFile of this.input.adapter.resolveMethodFiles(phase)) {
      if (!loadedMethods.has(methodFile) && !hostLoaded.has(methodFile)) {
        throw new Error(`phase가 필수 method file을 로드하지 않았다: ${methodFile}`);
      }
    }
  }

}
