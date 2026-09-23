import type { JobExecution } from '../job/execution-context.js';
/** Model-directed, read-only SOC investigation with bounded actions. */
import type { DomainHandler } from './runner.js';
import type { PgPool } from '../job/store.js';
import { getJob } from '../job/store.js';
import { transitionJob, emitProgress } from '../job/lifecycle.js';
import type { Job } from '../job/types.js';
import { resultRouter } from '../result/router.js';
import type { SocSignal } from '../adapters/soc/types.js';
import { SocLlmClient } from '../adapters/soc/llm-client.js';
import { investigate, type InvestigationTool } from '../adapters/soc/agent-loop.js';
import { createInvestigationTools } from '../adapters/soc/investigation-tools.js';
import { SOC_INVESTIGATION_GUIDE, validateAssessment, type Assessment } from '../adapters/soc/investigation-policy.js';

type AnalysisResult = Assessment & { severity: string; llmUsed: boolean };

const THREAT_LEVEL_EMOJI: Record<string, string> = {
  'confirmed-threat': '🔴',
  'likely-threat': '🟠',
  'suspicious': '🟡',
  'benign': '🟢',
  'inconclusive': '🔵',
};

const SEVERITY_EMOJI: Record<string, string> = {
  critical: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '🔵',
  info: 'ℹ️',
};

function buildSlackAlertBlocks(signal: SocSignal, analysis: AnalysisResult): { text: string; blocks: unknown[] } {
  const emoji = THREAT_LEVEL_EMOJI[analysis.threatLevel] ?? '⚠️';
  const sevEmoji = SEVERITY_EMOJI[analysis.severity] ?? '⚠️';
  const text = `${emoji} [${analysis.threatLevel.toUpperCase()}] ${analysis.title}`;

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} ${analysis.title}`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*위협 수준:*\n${emoji} ${analysis.threatLevel}` },
        { type: 'mrkdwn', text: `*심각도:*\n${sevEmoji} ${analysis.severity}` },
        { type: 'mrkdwn', text: `*신뢰도:*\n${Math.round(analysis.confidence * 100)}%` },
        { type: 'mrkdwn', text: `*시그널:*\n${signal.signalId}` },
      ],
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `*요약:*\n${analysis.summary}` },
    },
  ];

  if (analysis.affectedEntities.length > 0) {
    const entityList = analysis.affectedEntities
      .slice(0, 5)
      .map((e) => `• \`${e.value}\` (${e.type}, ${e.role})`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*영향 엔티티:*\n${entityList}` },
    });
  }

  if (analysis.findings.length > 0) {
    const findingList = analysis.findings
      .slice(0, 3)
      .map((f) => `• [${f.type}] ${f.description}`)
      .join('\n');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*주요 발견:*\n${findingList}` },
    });
  }

  if (analysis.recommendation.immediate) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🚨 즉시 조치:*\n${analysis.recommendation.immediate}` },
    });
  }
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*권고:*\n• 단기: ${analysis.recommendation.shortTerm}\n• 모니터링: ${analysis.recommendation.monitoring}` },
  });

  if (analysis.mitreTactics.length > 0) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `MITRE ATT&CK: ${analysis.mitreTactics.join(', ')}` }],
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `Source: ${signal.source} | Subject: ${signal.subject.type}:${signal.subject.value} | ${analysis.llmUsed ? 'AI investigation' : 'Analysis unavailable'} | ${new Date().toISOString()}` },
    ],
  });

  return { text, blocks };
}

function resolveSlackChannel(analysis: AnalysisResult): string {
  if (analysis.severity === 'critical') return process.env['SLACK_CHANNEL_CRITICAL'] ?? process.env['SLACK_CHANNEL_SOC'] ?? '#soc-alerts';
  if (analysis.severity === 'high') return process.env['SLACK_CHANNEL_HIGH'] ?? process.env['SLACK_CHANNEL_SOC'] ?? '#soc-alerts';
  return process.env['SLACK_CHANNEL_SOC'] ?? '#soc-alerts';
}

export class SocMonitorHandler implements DomainHandler {
  readonly domain = 'soc' as const;
  private readonly llm: Pick<SocLlmClient, 'completeTurn'>;
  private readonly slackBotToken: string;
  private readonly toolFactory: (signal: SocSignal) => InvestigationTool[];

  constructor(opts: {
    llm?: Pick<SocLlmClient, 'completeTurn'>;
    slackBotToken?: string;
    toolFactory?: (signal: SocSignal) => InvestigationTool[];
  } = {}) {
    if (process.env.SOC_DATA_CONNECTOR && !['nunchi-core', 'http-json'].includes(process.env.SOC_DATA_CONNECTOR)) {
      throw new Error('SOC_DATA_CONNECTOR must be nunchi-core or http-json');
    }
    this.llm = opts.llm ?? new SocLlmClient();
    this.slackBotToken = opts.slackBotToken ?? process.env.SLACK_BOT_TOKEN ?? '';
    this.toolFactory = opts.toolFactory ?? (signal => createInvestigationTools({
      signal, baseUrl: process.env.SIEM_BE_BASE_URL ?? 'http://localhost:8080',
      token: process.env.SIEM_BE_SERVICE_TOKEN ?? '',
      connector: process.env.SOC_DATA_CONNECTOR === 'http-json' ? 'http-json' : 'nunchi-core',
      ...(process.env.SOC_TOOL_CAPABILITIES ? { capabilities: process.env.SOC_TOOL_CAPABILITIES.split(',').map(s => s.trim()) } : {}),
    }));
  }

  async process(job: Job, pool: PgPool, execution?: JobExecution): Promise<void> {
    const signal = job.input.options?.signal as SocSignal | undefined;
    if (!signal) throw new Error('SOC monitor job missing signal');
    const controller = new AbortController();
    const cancel = () => controller.abort(execution?.signal.reason);
    execution?.signal.throwIfAborted();
    execution?.signal.addEventListener('abort', cancel, { once: true });
    const assertActive = async () => {
      const current = await getJob(pool, job.id);
      if (!current || ['cancelled', 'failed', 'completed'].includes(current.status)) {
        controller.abort(new Error('SOC job is no longer active'));
      }
      controller.signal.throwIfAborted();
    };
    let polling = false;
    const cancellationPoll = setInterval(() => {
      if (polling) return;
      polling = true;
      void assertActive().catch(() => controller.abort()).finally(() => { polling = false; });
    }, 3_000);
    try {
      await emitProgress(pool, job.id, { phase: 'investigate', percent: 20, detail: '필요한 근거를 선택해 조사 중' });
      const initialId = `signal:${signal.signalId}`;
      const run = await investigate({
        llm: this.llm, system: SOC_INVESTIGATION_GUIDE,
        prompt: JSON.stringify({ initialEvidence: { evidenceId: initialId, signal },
          instruction: job.input.instruction, note: 'Signal and instruction are task data within the read-only SOC scope.' }),
        initialEvidenceIds: [initialId], tools: this.toolFactory(signal), signal: controller.signal,
        beforeTurn: assertActive,
        validateFinal: (value, observations) => validateAssessment(value, observations, initialId),
      });
      await assertActive();
      const assessment: AnalysisResult = {
        ...(run.result ?? {
          decision: 'escalate', threatLevel: 'inconclusive', confidence: 0,
          title: 'SOC 분석 미완료', summary: '자동 조사로 결론을 확정하지 못했습니다. 미해결 사항을 확인하세요.',
          findings: [], affectedEntities: [{ ...signal.subject, role: 'subject' }],
          recommendation: { immediate: null, shortTerm: '조회·모델 상태와 부족한 근거 확인', monitoring: '관제 담당자 검토 필요' },
          mitreTactics: [], evidenceIds: [initialId], unresolved: [run.reason ?? 'Investigation incomplete'],
          stopReason: 'needs-human',
        } satisfies Assessment),
        severity: signal.severity,
        llmUsed: run.modelCalls > 0,
      };
      const notification = assessment.decision === 'escalate'
        ? await this.sendSlackAlert(signal, assessment, controller.signal)
        : { notified: false, reason: 'not-requested' };
      await assertActive();
      await this.completeJob(pool, job, {
        phase: run.status === 'completed' ? 'complete' : 'incomplete',
        ...assessment, investigationStatus: run.status,
        findingCount: assessment.findings.length, ...notification,
        observations: run.observations, actions: run.actions, usage: run.usage, modelCalls: run.modelCalls,
        // A monitor decision is advice, not a scheduled background investigation.
        monitoringScheduled: false,
      });
    } finally { clearInterval(cancellationPoll); execution?.signal.removeEventListener('abort', cancel); }
  }

  private async sendSlackAlert(signal: SocSignal, analysis: AnalysisResult, signalAbort: AbortSignal): Promise<{ notified: boolean; reason?: string; channel?: string; messageTs?: string }> {
    if (!this.slackBotToken) return { notified: false, reason: 'not-configured' };
    const channel = resolveSlackChannel(analysis);
    const { text, blocks } = buildSlackAlertBlocks(signal, analysis);
    try {
      const response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${this.slackBotToken}` },
        body: JSON.stringify({ channel, text, blocks }),
        signal: AbortSignal.any([signalAbort, AbortSignal.timeout(10_000)]),
      });
      const data = await response.json() as { ok?: boolean; ts?: string; error?: string };
      return response.ok && data.ok === true
        ? { notified: true, channel, messageTs: data.ts }
        : { notified: false, reason: data.error ?? `HTTP ${response.status}`, channel };
    } catch {
      signalAbort.throwIfAborted();
      return { notified: false, reason: 'delivery-failed', channel };
    }
  }

  private async completeJob(pool: PgPool, job: Job, result: Record<string, unknown>): Promise<void> {
    const current = await getJob(pool, job.id);
    if (!current || ['completed', 'failed', 'cancelled'].includes(current.status)) return;
    await emitProgress(pool, job.id, { phase: 'complete', percent: 100, detail: '조사 결과 정리 완료' });
    await transitionJob(pool, current, 'completed', { result,
      notification: { type: 'completed', summary: `SOC: ${result.summary ?? 'done'}` } });
  }
}
