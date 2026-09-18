import type { ProviderCapability } from '../contracts/workflow-contract.js';
import { DOMAINS, runSession, type LedgerRow, type SessionOutcome, type SessionSpec } from '../session.js';
import {
  assertProviderCapabilities,
  ProviderRuntimeFailure,
  type ProviderPhaseOutcome,
  type ProviderPhaseRequest,
  type ProviderRuntime,
  type ProviderRuntimeEvent,
} from './provider-runtime.js';

export type AnthropicPhaseOptions = {
  model?: string;
  effort?: SessionSpec['effort'];
  maxTurns?: number;
  phaseRound?: string;
  networkAllowedDomains?: readonly string[];
  readScope?: SessionSpec['readScope'];
  disabledTools?: readonly string[];
};

const CAPABILITIES = new Set<ProviderCapability>([
  'structured-output',
  'strict-tool-input',
  'local-mcp',
  'sandbox',
  'tool-policy',
]);

export class AnthropicAgentRuntime implements ProviderRuntime<AnthropicPhaseOptions, SessionOutcome> {
  readonly name = 'anthropic-agent-sdk';
  readonly capabilities = CAPABILITIES;

  constructor(private readonly sessionRunner: typeof runSession = runSession) {}

  async runPhase(
    request: ProviderPhaseRequest<AnthropicPhaseOptions>,
  ): Promise<ProviderPhaseOutcome<SessionOutcome>> {
    assertProviderCapabilities(this, request.requiredCapabilities);
    if (!DOMAINS.includes(request.domain as (typeof DOMAINS)[number])) {
      throw new Error(`Anthropic runtime에 등록되지 않은 domain이다: ${request.domain}`);
    }
    const events: ProviderRuntimeEvent[] = [];
    let outcome: SessionOutcome;
    try {
      outcome = await this.sessionRunner({
        domain: request.domain as SessionSpec['domain'],
        mission: request.mission,
        entryAgent: request.role,
        agentRole: request.role,
        phase: request.phase,
        phaseRound: request.options?.phaseRound,
        target: request.target,
        prompt: request.prompt,
        engagementDir: request.engagementDir,
        engagementId: request.runId,
        model: request.options?.model,
        effort: request.options?.effort,
        maxTurns: request.options?.maxTurns,
        maxBudgetUsd: request.maxBudgetUsd,
        allowedReadFiles: request.allowedReadFiles,
        networkAllowedDomains: request.options?.networkAllowedDomains,
        readScope: request.options?.readScope,
        disabledTools: request.options?.disabledTools,
        onLedger: (row) => {
          const event = normalizeLedgerRow(row);
          events.push(event);
          request.onEvent?.(event);
        },
      });
    } catch (cause) {
      throw new ProviderRuntimeFailure(
        'Anthropic session이 완전한 usage receipt 전에 실패했다',
        {
          provider: this.name,
          ...(request.options?.model ? { model: request.options.model } : {}),
          costUsd: 0,
          accountingComplete: false,
          raw: { reason: cause instanceof Error ? cause.message : String(cause) },
        },
        { cause },
        events,
      );
    }
    for (let index = events.length; index < outcome.ledger.length; index += 1) {
      const event = normalizeLedgerRow(outcome.ledger[index]!);
      events.push(event);
      request.onEvent?.(event);
    }
    let actualModel: string | undefined;
    try {
      actualModel = resolveActualModel(request.options?.model, outcome.modelUsage);
    } catch (cause) {
      throw new ProviderRuntimeFailure(
        'Anthropic model identity receipt가 요청 모델과 일치하지 않는다',
        {
          provider: this.name,
          costUsd: outcome.totalCostUsd ?? 0,
          accountingComplete: false,
          raw: { modelUsage: outcome.modelUsage, reason: cause instanceof Error ? cause.message : String(cause) },
        },
        { cause },
        events,
      );
    }
    const usage = {
      provider: this.name,
      ...(actualModel ? { model: actualModel, modelIdentityVerified: true } : {}),
      turns: outcome.numTurns,
      costUsd: outcome.totalCostUsd ?? 0,
      accountingComplete: true,
      raw: outcome.modelUsage,
    };
    if (outcome.subtype !== undefined && outcome.subtype !== 'success') {
      throw new ProviderRuntimeFailure(
        `Anthropic session 결과가 실패했다: ${outcome.subtype}`,
        usage,
        { cause: new Error(outcome.terminalReason ?? outcome.errors?.join('; ') ?? outcome.subtype) },
        events,
      );
    }
    if (
      request.requiredCapabilities.includes('structured-output')
      && outcome.structuredOutput === undefined
    ) {
      throw new ProviderRuntimeFailure(
        `Anthropic session이 구조화 출력 없이 종료됐다: subtype=${outcome.subtype ?? 'unknown'} terminal=${outcome.terminalReason ?? 'unknown'}`,
        usage,
        { cause: new Error(`resultText=${outcome.resultText ? 'present' : 'absent'} mainTexts=${outcome.texts.length}`) },
        events,
      );
    }
    return {
      provider: this.name,
      texts: outcome.texts,
      events,
      structuredOutput: outcome.structuredOutput,
      usage,
      registeredAgents: outcome.registeredAgents,
      raw: outcome,
    };
  }
}

function resolveActualModel(requested: string | undefined, modelUsage: unknown): string | undefined {
  if (!requested) return undefined;
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) {
    throw new Error('modelUsage map이 없다');
  }
  const candidates = Object.entries(modelUsage as Record<string, unknown>)
    .filter(([, usage]) => usage !== null && typeof usage === 'object' && !Array.isArray(usage))
    .map(([model]) => model);
  const matches = candidates.filter((model) => matchesRequestedModel(requested, model));
  if (matches.length !== 1) {
    throw new Error(`requested=${requested} actual=${candidates.join(',') || '(none)'}`);
  }
  return matches[0]!.toLowerCase();
}

function matchesRequestedModel(requested: string, actual: string): boolean {
  const normalizedRequested = requested.toLowerCase();
  const normalizedActual = actual.toLowerCase();
  if (normalizedActual === normalizedRequested) return true;

  if (/^(?:opus|sonnet|haiku)$/.test(normalizedRequested)) {
    return new RegExp(
      `^claude-(?:\\d+(?:-\\d+)*-)?${normalizedRequested}(?:-(?:\\d+|latest))*$`,
    ).test(normalizedActual);
  }

  const stableAlias = normalizedRequested.endsWith('-latest')
    ? normalizedRequested.slice(0, -'-latest'.length)
    : normalizedRequested;
  if (!/^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(stableAlias)) return false;
  if (/\d{8}$/.test(stableAlias)) return false;
  return normalizedActual === stableAlias || new RegExp(`^${stableAlias}-\\d{8}$`).test(normalizedActual);
}

function normalizeLedgerRow(row: LedgerRow): ProviderRuntimeEvent {
  return {
    at: row.at,
    event: row.event,
    actor: row.agentType,
    tool: row.tool,
    resource: row.resource,
    query: row.query,
    decision: row.decision,
    reason: row.reason,
    ...(row.compaction ? { compaction: row.compaction } : {}),
  };
}
