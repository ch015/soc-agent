import { ACTION_GUIDANCE } from './workflow/action-guidance.js';
/**
 * 세션 조립 — 미션 요청을 SDK `query()` 호출로 번역하는 유일한 지점.
 *
 * 여기 없는 것: 취약점 판정, 페르소나 프롬프트 내용, 증거·커버리지 게이트 로직,
 * 에이전트 실행 순서. 판정 방법론과 저수준 게이트는 도메인 플러그인이 갖고,
 * 실행 순서와 phase 전이는 호스트 미션이 갖는다.
 *
 * 관측된 계약에 의존한다 — 근거는 docs/002-plugin-contract-findings.md:
 *   F1  플러그인의 `hooks/hooks.json` 커맨드 훅이 발화한다. `settingSources: []`와 무관하다.
 *   F2  에이전트 정식 이름은 `<플러그인>:<하위경로>:<이름>`.
 *   F5  위임 시 bare 이름도 정식 이름으로 해석된다.
 *   F4  벤더 트리는 CommonJS이고 `domains/<d>/package.json`이 그것을 국소화한다.
 */
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import {
  query,
  type HookInput,
  type Options,
  type Query,
} from '@anthropic-ai/claude-agent-sdk';

import {
  DOMAINS,
  type CompactBoundaryMetadata,
  type Domain,
  type LedgerRow,
  type SessionSpec,
} from './session-types.js';
export {
  DOMAINS,
  type CompactBoundaryMetadata,
  type Domain,
  type LedgerRow,
  type SessionSpec,
} from './session-types.js';
import {
  authorizeToolCall,
  canonicalPotentialPath,
  createToolPolicy,
} from './workflow/policy.js';
import { getDomainAdapter } from './domains/registry.js';
import { domainAgentNames, domainPluginPath, safeParentEnv } from './session-support.js';
export { domainAgentNames, domainPluginPath } from './session-support.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Options 조립. 순수 함수 — 격리 회귀를 단위테스트 하나로 잡기 위해 분리한다.
 */
export function buildOptions(spec: SessionSpec): Options {
  if (!isAbsolute(spec.target)) {
    throw new Error(`target 은 절대경로여야 한다: ${spec.target}`);
  }
  if (!existsSync(spec.target)) {
    throw new Error(`진단 대상이 없다: ${spec.target}`);
  }
  const targetRealpath = realpathSync(spec.target);
  const homeRealpath = process.env.HOME && existsSync(process.env.HOME)
    ? realpathSync(process.env.HOME)
    : undefined;
  if (targetRealpath === resolve('/') || targetRealpath === homeRealpath) {
    throw new Error(`진단 대상이 지나치게 넓다: ${targetRealpath}`);
  }
  if (!isAbsolute(spec.engagementDir)) {
    throw new Error(`engagementDir은 절대경로여야 한다: ${spec.engagementDir}`);
  }
  const engagementPath = canonicalPotentialPath(spec.engagementDir, spec.target);
  if (
    engagementPath === targetRealpath ||
    engagementPath === resolve('/') ||
    engagementPath === homeRealpath
  ) {
    throw new Error(`engagementDir 쓰기 범위가 지나치게 넓다: ${engagementPath}`);
  }

  const pluginPath = domainPluginPath(spec.domain);
  const adapter = getDomainAdapter(spec.domain, spec.mission);
  const workflowContract = adapter.contract;
  if (!spec.phase) throw new Error(`${spec.domain}/${adapter.mission} 세션에는 contract phase가 필요하다`);
  const { workflow: workflowPhase, legacy: phase } = adapter.getPhase(spec.phase);
  const explicitAgents = adapter.buildAgentDefinitions();
  if (!spec.allowedReadFiles || spec.allowedReadFiles.length === 0) {
    throw new Error(`${spec.domain}/${adapter.mission} 세션에는 host exact read allow-list가 필요하다`);
  }
  const entryAgent = workflowPhase.role;
  const agentRole = workflowPhase.role;
  const entryAgentDefinition = explicitAgents[entryAgent];
  if (!entryAgentDefinition) {
    throw new Error(`entryAgent가 ${workflowContract.id} roles에 없다: ${entryAgent}`);
  }
  const phaseArtifacts = adapter.renderArtifacts(phase, spec.phaseRound);
  const allowedPhaseArtifacts = new Set([...phaseArtifacts.required, ...phaseArtifacts.optional]);
  const allowedMethodFiles = new Set(
    adapter.resolveMethodFiles(phase),
  );
  if (spec.entryAgent && explicitAgents && !explicitAgents[spec.entryAgent]) {
    throw new Error(`entryAgent가 ${workflowContract.id} roles에 없다: ${spec.entryAgent}`);
  }
  if (workflowPhase && spec.entryAgent !== undefined && spec.entryAgent !== workflowPhase.role) {
    throw new Error(`phase/entryAgent 계약 불일치: ${workflowPhase.id}/${workflowPhase.role} != ${String(spec.entryAgent)}`);
  }
  if (workflowPhase && spec.agentRole && workflowPhase.role !== spec.agentRole) {
    throw new Error(`phase/role 계약 불일치: ${workflowPhase.id}/${workflowPhase.role} != ${spec.agentRole}`);
  }
  const roleContract = workflowContract.roles[workflowPhase.role];
  if (!roleContract) throw new Error(`세션 role 계약이 없다: ${workflowPhase.role}`);
  const networkAllowedDomains: string[] = [];
  if (spec.networkAllowedDomains?.length) {
    throw new Error('SOC 모델 세션은 네트워크 접근을 허용하지 않는다');
  }
  const disabledTools = new Set(spec.disabledTools ?? []);
  for (const tool of disabledTools) {
    if (!roleContract.tools.includes(tool)) throw new Error(`비계약 도구를 disable할 수 없다: ${tool}`);
  }
  const effectiveTools = roleContract.tools.filter((tool) => !disabledTools.has(tool));
  const methodologyFiles = adapter.resolveMethodologyFiles?.(phase) ?? [];
  const knowledgeFiles = adapter.resolveKnowledgeFiles?.(phase) ?? [];
  const phaseVisibleReadFiles = [
    ...(spec.allowedReadFiles ?? []),
    ...[...phaseArtifacts.required, ...phaseArtifacts.optional].map((name) =>
      join(spec.engagementDir, name),
    ),
    ...knowledgeFiles,
  ];
  const toolPolicy = createToolPolicy({
    contractId: workflowContract.id,
    domain: spec.domain,
    phase: workflowPhase.id,
    role: agentRole,
    targetDir: spec.target,
    engagementDir: spec.engagementDir,
    allowedTools: new Set(effectiveTools),
    allowedReadRoots: [],
    allowImplicitRootRead: false,
    ...(phaseVisibleReadFiles.length > 0 ? { allowedReadFiles: phaseVisibleReadFiles } : {}),
    allowedMethodFiles: new Set([...allowedMethodFiles, ...methodologyFiles]),
    allowedArtifacts: allowedPhaseArtifacts,
    allowedDelegates: new Set(roleContract.allowedDelegates),
  });
  const emit = (row: LedgerRow): void => spec.onLedger?.(row);
  const record = (input: HookInput, extra: Partial<LedgerRow> = {}): void => {
    const toolInput =
      'tool_input' in input ? (input.tool_input as Record<string, unknown> | null) : null;
    const resource = toolInput?.file_path ?? toolInput?.path ?? toolInput?.notebook_path;
    const row: LedgerRow = {
      at: new Date().toISOString(),
      event: input.hook_event_name,
      agentId: input.agent_id,
      agentType: input.agent_type,
      tool: 'tool_name' in input ? String(input.tool_name) : undefined,
      resource: typeof resource === 'string' ? resource : undefined,
      query:
        typeof toolInput?.pattern === 'string'
          ? toolInput.pattern
          : typeof toolInput?.query === 'string'
            ? toolInput.query
            : undefined,
      ...extra,
    };
    emit(row);
  };

  return {
    cwd: spec.engagementDir,
    // SDK 0.3.220은 `agent`와 `outputFormat`을 함께 지정하면 success여도
    // structured_output을 생략한다. 주 실행은 root에 두고 역할 계약만 system prompt로 주입한다.
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: `${entryAgentDefinition.prompt}\n\n${ACTION_GUIDANCE}`,
    },
    ...(explicitAgents ? { agents: explicitAgents } : {}),
    model: spec.model ?? 'opus',
    ...(spec.effort ? { effort: spec.effort } : {}),
    maxTurns: spec.maxTurns ?? 120,
    ...(spec.maxBudgetUsd !== undefined ? { maxBudgetUsd: spec.maxBudgetUsd } : {}),
    ...(spec.abortController ? { abortController: spec.abortController } : {}),
    ...(spec.onStderr ? { stderr: spec.onStderr } : {}),
    ...(spec.onProgress ? { forwardSubagentText: true } : {}),
    outputFormat: adapter.outputFormat(phase),
    tools: [...effectiveTools],
    allowedTools: [...effectiveTools],
    disallowedTools: [...workflowContract.forbiddenModelTools],
    // 격리 — 사용자/프로젝트 settings.json 과 외부 MCP 를 차단한다.
    // 플러그인 훅은 이것과 무관하게 발화한다 (F1).
    settingSources: [],
    strictMcpConfig: true,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: networkAllowedDomains, strictAllowlist: true },
      filesystem: {
        allowWrite: [spec.engagementDir],
        denyWrite: [spec.target],
        denyRead: [spec.target],
        allowRead: [...phaseVisibleReadFiles, ...allowedMethodFiles, ...methodologyFiles],
      },
    },
    permissionMode: workflowContract.isolation.permissionMode,

    // 도메인 하나만 로드한다. 다른 그룹의 에이전트는 이 세션에 존재하지 않는다.
    plugins: [{ type: 'local', path: pluginPath }],
    skills: [...roleContract.skills],

    // 벤더 훅이 읽는 런타임 환경. ANTHROPIC_API_KEY는 SDK 인증에 필수이므로
    // 예외적으로 전달한다 — sandbox network strictAllowlist로 유출 경로를 통제한다.
    env: {
      ...safeParentEnv(),
      // P1: 인증 모드에 따라 API 키 전달 여부 결정
      // AUTH_MODE=oauth이면 API 키를 전달하지 않아 SDK가 OAuth 경로를 사용하도록 한다.
      // AUTH_MODE=api_key(기본)이면 API 키를 명시적으로 전달한다.
      ...(process.env.AUTH_MODE !== 'oauth' && process.env.ANTHROPIC_API_KEY
        ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
        : {}),
      PROJECT_DIR: spec.target,
      AGENT_ENGAGEMENT_DIR: spec.engagementDir,
      AGENT_ENGAGEMENT_ID: spec.engagementId,
      AGENT_REPORTS_DIR: spec.engagementDir,
      ...(agentRole ? { AGENT_ROLE: agentRole } : {}),
      ...(spec.phase ? { AGENT_PHASE: spec.phase } : {}),
      AGENT_MISSION: adapter.mission,
      ...(spec.phaseRound ? { AGENT_PHASE_ROUND: spec.phaseRound } : {}),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
      AGENT_CONTRACT_ID: workflowContract.id,
      AGENT_CONTRACT_VERSION: workflowContract.version,
    },

    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (input) => {
              const tool = 'tool_name' in input ? String(input.tool_name) : '';
              const toolInput =
                'tool_input' in input
                  ? (input.tool_input as Record<string, unknown> | null)
                  : null;
              const decision = authorizeToolCall(toolPolicy, {
                tool,
                input: toolInput,
                ...(input.agent_type ? { agentType: input.agent_type } : {}),
              });
              record(input, { decision: decision.decision, reason: decision.reason });
              if (
                decision.decision === 'allow' &&
                decision.updatedInput === undefined
              ) {
                return { continue: true };
              }
              return {
                continue: true,
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  permissionDecision: decision.decision,
                  permissionDecisionReason: decision.reason,
                  ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
                },
              };
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: 'Write',
          hooks: [
            async (input) => {
              if (input.hook_event_name !== 'PostToolUse') return { continue: true };
              return { continue: true };
            },
          ],
        },
      ],
      // 위임 그래프 — 누가 언제 어떤 워커를 띄웠는지
      SubagentStart: [{ hooks: [async (i) => (record(i), { continue: true })] }],
      SubagentStop: [{ hooks: [async (i) => (record(i), { continue: true })] }],
    },
  };
}

export type SessionOutcome = {
  /** 메인 스레드가 남긴 텍스트 */
  texts: string[];
  ledger: LedgerRow[];
  /** SDK 가 보고한 종료 사유 */
  subtype?: string;
  terminalReason?: string;
  resultText?: string;
  errors?: string[];
  numTurns?: number;
  totalCostUsd?: number;
  /** 모델별 토큰 회계 */
  modelUsage?: unknown;
  /** outputFormat JSON schema로 검증된 phase 결과 */
  structuredOutput?: unknown;
  /** SDK structured_output 또는 엄격한 최종 assistant JSON 복구 경로 */
  structuredOutputSource?: 'sdk' | 'assistant-json';
  /** 세션에 등록된 서브에이전트 — 도메인 플러그인이 실제로 로드됐는지 확증한다 */
  registeredAgents?: { name: string; description: string; model?: string }[];
};

/**
 * 세션 구동. 스트림을 소비하며 원장과 회계를 모은다.
 */
export async function runSession(spec: SessionSpec): Promise<SessionOutcome> {
  const ledger: LedgerRow[] = [];
  const emitLedger = (row: LedgerRow): void => {
    ledger.push(row);
    spec.onLedger?.(row);
  };
  const options = buildOptions({
    ...spec,
    onLedger: emitLedger,
  });
  mkdirSync(spec.engagementDir, { recursive: true, mode: 0o700 });

  const q: Query = query({ prompt: spec.prompt, options });
  const outcome: SessionOutcome = { texts: [], ledger };

  for await (const message of q) {
    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      const metadata: CompactBoundaryMetadata = {
        trigger: message.compact_metadata.trigger,
        preTokens: message.compact_metadata.pre_tokens,
        ...(message.compact_metadata.post_tokens !== undefined
          ? { postTokens: message.compact_metadata.post_tokens }
          : {}),
        ...(message.compact_metadata.duration_ms !== undefined
          ? { durationMs: message.compact_metadata.duration_ms }
          : {}),
        boundaryId: message.uuid,
      };
      emitLedger({ at: new Date().toISOString(), event: 'compact_boundary', compaction: metadata });
    }
    if (message.type === 'system' && message.subtype === 'init') {
      outcome.registeredAgents = await q.supportedAgents().catch(() => undefined);
    }
    if (message.type === 'assistant') {
      // parent_tool_use_id 가 있으면 서브에이전트의 발화다 (forwardSubagentText).
      const fromSubagent =
        'parent_tool_use_id' in message && message.parent_tool_use_id !== null;
      for (const block of message.message.content) {
        if (block.type === 'text') {
          if (fromSubagent) {
            spec.onProgress?.({ kind: 'text', from: 'subagent', detail: block.text });
          } else {
            outcome.texts.push(block.text);
          }
        } else if (block.type === 'tool_use') {
          spec.onProgress?.({
            kind: 'tool',
            from: fromSubagent ? 'subagent' : 'main',
            detail: block.name,
          });
        }
      }
    }
    if (message.type === 'result') {
      outcome.subtype = message.subtype;
      outcome.terminalReason = message.terminal_reason;
      outcome.numTurns = message.num_turns;
      outcome.totalCostUsd = message.total_cost_usd;
      if ('modelUsage' in message) outcome.modelUsage = message.modelUsage;
      if (message.subtype === 'success') outcome.resultText = message.result;
      else outcome.errors = message.errors;
      if ('structured_output' in message && message.structured_output !== undefined) {
        outcome.structuredOutput = message.structured_output;
        outcome.structuredOutputSource = 'sdk';
      }
    }
  }

  if (outcome.subtype === 'success' && outcome.structuredOutput === undefined) {
    const recovered = recoverStructuredOutput(outcome.resultText ? [outcome.resultText] : outcome.texts);
    if (recovered !== undefined) {
      outcome.structuredOutput = recovered;
      outcome.structuredOutputSource = 'assistant-json';
    }
  }

  return outcome;
}

export function recoverStructuredOutput(texts: readonly string[]): unknown | undefined {
  const last = [...texts].reverse().find((text) => text.trim().length > 0)?.trim();
  if (!last) return undefined;
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(last);
  const candidate = fenced?.[1] ?? last;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}
