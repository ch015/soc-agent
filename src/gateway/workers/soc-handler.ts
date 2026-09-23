import type { JobExecution } from '../job/execution-context.js';
/**
 * SOC DomainHandler — the core orchestration for SOC jobs.
 *
 * Flow: verify prepared snapshot → socReport/socInvestigation → classify actions →
 *       approval gate → playbook execute → route results.
 */
import type { DomainHandler } from './runner.js';
import type { PgPool } from '../job/store.js';
import { getJob } from '../job/store.js';
import { transitionJob, emitProgress } from '../job/lifecycle.js';
import type { Job } from '../job/types.js';
import { runSession } from '../../runtime/session.js';
import { executeSocSnapshot, redactionTrustFromEnv } from '../../runtime/soc-execution.js';
import { SocMissionSchema } from '../../runtime/contracts/soc-schemas.js';
import type { SocSignal, AdvisoryAction } from '../adapters/soc/types.js';
import { ApprovalGate } from '../approval/gate.js';
import { PlaybookExecutor } from '../playbook/executor.js';
import type { Playbook, ExecutionContext } from '../playbook/types.js';
import { SlackNotifyConnector } from '../playbook/connectors/slack-notify.js';
import { JiraIncidentConnector } from '../playbook/connectors/jira-incident.js';
import { GenericWebhookConnector } from '../playbook/connectors/generic-webhook.js';
import { insertPlaybookExecution } from '../job/store.js';

/** SOC progress phases. */
const PHASES = {
  collecting: { phase: 'collecting', percent: 10, detail: '로그 수집 중' },
  analyzing: { phase: 'analyzing', percent: 40, detail: '분석 실행 중' },
  classifying: { phase: 'classifying', percent: 70, detail: '액션 분류 중' },
  approval: { phase: 'approval', percent: 80, detail: '승인 게이트 처리 중' },
  executing: { phase: 'executing', percent: 90, detail: '플레이북 실행 중' },
  complete: { phase: 'complete', percent: 100, detail: '완료' },
} as const;

/**
 * SocHandler — processes SOC signals end-to-end.
 */
export class SocHandler implements DomainHandler {
  readonly domain = 'soc' as const;

  private readonly approvalGate: ApprovalGate;
  private readonly playbookExecutor: PlaybookExecutor;

  constructor(opts?: {
    approvalGate?: ApprovalGate;
    playbookExecutor?: PlaybookExecutor;
  }) {
    this.approvalGate = opts?.approvalGate ?? new ApprovalGate();
    this.playbookExecutor = opts?.playbookExecutor ?? this.buildDefaultExecutor();
  }

  async process(job: Job, pool: PgPool, execution?: JobExecution): Promise<void> {
    execution?.signal.throwIfAborted();
    const signal = job.input.options?.signal as SocSignal | undefined;
    if (!signal) {
      throw new Error('SOC job missing signal in input.options');
    }

    const missionType = SocMissionSchema.parse(job.input.options?.missionType ?? 'report');

    try {
      // 1. Collect logs
      await emitProgress(pool, job.id, PHASES.collecting);

      const snapshot = job.input.options?.preparedSnapshot;
      if (!snapshot || typeof snapshot !== 'object' || !('mission' in snapshot) || snapshot.mission !== missionType) {
        throw new Error('SOC v1 requires options.preparedSnapshot with a matching missionType');
      }
      await emitProgress(pool, job.id, PHASES.analyzing);
      const mission = await executeSocSnapshot(snapshot, {
        tenantId: job.tenantId,
        actorId: job.tenantId,
        scopes: [missionType === 'report' ? 'soc:report:read' : 'soc:investigation:read'],
      }, {
        engagementId: `soc-${job.id}-${job.attempts}`,
        model: process.env.DEFAULT_MODEL,
        reviewModel: process.env.DEFAULT_REVIEW_MODEL,
      }, { redactionTrust: redactionTrustFromEnv(), sessionRunner: async spec => {
        const controller = new AbortController();
        const abort = () => controller.abort(execution?.signal.reason);
        execution?.signal.throwIfAborted();
        execution?.signal.addEventListener('abort', abort, { once: true });
        try { return await runSession({ ...spec, abortController: controller }); }
        finally { execution?.signal.removeEventListener('abort', abort); }
      } });
      // v1 results are reviewed advisory drafts. Their advice does not authorize a playbook.
      const analysisResult: Record<string, unknown> = {
        status: mission.status,
        mission: mission.mission,
        draftPath: mission.draftPath,
        engagementDir: mission.engagementDir,
        phases: mission.phases.map(({ phase, role, result }) => ({ phase, role, result })),
      };

      // 3. Classify actions
      await emitProgress(pool, job.id, PHASES.classifying);

      const advisoryActions = (analysisResult.advisoryActions as AdvisoryAction[] | undefined) ?? [];
      const hasContainmentActions = advisoryActions.some(
        (a) => a.category === 'contain' || a.category === 'eradicate',
      );

      // 4. Approval gate
      await emitProgress(pool, job.id, PHASES.approval);

      if (advisoryActions.length > 0) {
        const { autoApproved, manualRequired, blocked } = this.approvalGate.evaluateAll(advisoryActions);

        // Record all decisions
        for (const action of advisoryActions) {
          const result = this.approvalGate.evaluate(action);
          await this.approvalGate.recordDecision(pool, job.id, result, action, '1.0.0');
        }

        // If there are manual-required actions, transition to action_pending
        if (manualRequired.length > 0 && hasContainmentActions) {
          const refetched = await getJob(pool, job.id);
          if (refetched && refetched.status === 'running') {
            await transitionJob(pool, refetched, 'action_pending' as Job['status'], {
              notification: { type: 'progress', phase: 'approval_pending', percent: 80 },
              progress: {
                ...PHASES.approval,
                pendingActions: manualRequired.map((r) => r.actionKey),
                autoApprovedActions: autoApproved.map((r) => r.actionKey),
                blockedActions: blocked.map((r) => r.actionKey),
              },
            });
          }

          return; // Wait for manual approval via POST /api/v1/jobs/:id/approve
        }

        // 5. Execute auto-approved actions
        if (autoApproved.length > 0) {
          await emitProgress(pool, job.id, PHASES.executing);

          const refetched = await getJob(pool, job.id);
          if (refetched && refetched.status === 'running') {
            await transitionJob(pool, refetched, 'action_executing' as Job['status']);
          }

          const context: ExecutionContext = {
            jobId: job.id,
            tenantId: job.tenantId,
            signalId: signal.signalId,
            severity: signal.severity,
            signal: signal as unknown as Record<string, unknown>,
          };

          // Find matching playbook
          const playbook = this.findPlaybook(autoApproved.map((r) => r.actionType), signal);
          if (playbook) {
            const execResult = await this.playbookExecutor.execute(playbook, context);

            // Record execution
            await insertPlaybookExecution(pool, {
              jobId: job.id,
              playbookId: playbook.id,
              status: execResult.status,
              steps: execResult.steps,
              totalAffectedEntities: execResult.totalAffectedEntities,
            });
          }
        }
      }

      // 6. Complete
      await emitProgress(pool, job.id, PHASES.complete);

      const refetched = await getJob(pool, job.id);
      if (refetched && (refetched.status === 'running' || refetched.status === ('action_executing' as Job['status']))) {
        await transitionJob(pool, refetched, 'completed', {
          notification: { type: 'completed', summary: `SOC ${missionType} ${mission.status} — ${signal.severity} signal from ${signal.source}` },
          result: {
            analysisResult,
            actionsExecuted: advisoryActions.length,
            missionType,
          },
        });
      }

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const refetched = await getJob(pool, job.id);
      if (refetched && !['completed', 'failed', 'cancelled'].includes(refetched.status)) {
        await transitionJob(pool, refetched, 'failed', {
          notification: { type: 'failed', error: errorMessage },
          error: {
            message: errorMessage,
            stack: err instanceof Error ? err.stack : undefined,
            category: 'soc_analysis_failure',
          },
        });
      }

      throw err;
    }
  }

  /**
   * Resume after manual approval.
   */
  async resume(job: Job, input: unknown, pool: PgPool, execution?: JobExecution): Promise<void> {
    const approval = input as { decision: 'approve' | 'deny'; rationale?: string };
    execution?.signal.throwIfAborted();
    const signal = job.input.options?.signal as SocSignal | undefined;
    if (!signal) throw new Error('SOC job missing signal');

    if (approval.decision === 'deny') {
      const refetched = await getJob(pool, job.id);
      if (refetched) {
        await transitionJob(pool, refetched, 'completed', {
          result: { denied: true, rationale: approval.rationale },
          notification: { type: 'completed', summary: 'SOC action denied' },
        });
      }
      return;
    }

    // Transition to action_executing
    const refetched = await getJob(pool, job.id);
    if (refetched && refetched.status !== 'action_executing') {
      await transitionJob(pool, refetched, 'action_executing' as Job['status']);
    }

    await emitProgress(pool, job.id, PHASES.executing);

    const context: ExecutionContext = {
      jobId: job.id,
      tenantId: job.tenantId,
      signalId: signal.signalId,
      severity: signal.severity,
      signal: signal as unknown as Record<string, unknown>,
    };

    // Re-evaluate for the pending actions and execute
    const advisoryActions = (job.progress as Record<string, unknown>)?.pendingActions as string[] | undefined;
    if (advisoryActions && advisoryActions.length > 0) {
      const playbook = this.findPlaybook(advisoryActions, signal);
      if (playbook) {
        const execResult = await this.playbookExecutor.execute(playbook, context);
        await insertPlaybookExecution(pool, {
          jobId: job.id,
          playbookId: playbook.id,
          status: execResult.status,
          steps: execResult.steps,
          totalAffectedEntities: execResult.totalAffectedEntities,
        });
      }
    }

    // Complete
    const final = await getJob(pool, job.id);
    if (final && final.status !== 'completed') {
      await transitionJob(pool, final, 'completed', {
        result: { approved: true, rationale: approval.rationale },
        notification: { type: 'completed', summary: 'SOC approved action completed' },
      });
    }
  }

  private findPlaybook(actionTypes: string[], signal: SocSignal): Playbook | null {
    // Built-in observe playbook
    const observePlaybook: Playbook = {
      id: 'pb-observe-notify',
      name: 'Observe & Notify',
      version: '1.0.0',
      category: 'observe',
      trigger: { actionTypes: ['notify-team', 'create-incident', 'increase-monitoring'] },
      steps: [
        {
          id: 'step-notify',
          action: 'notify-team',
          target: 'soc-alerts',
          timeout: '30s',
          continueOnFailure: true,
        },
      ],
      limits: {
        maxExecutionTime: '5m',
        maxAffectedEntities: 100,
        requireConfirmationAbove: 50,
      },
    };

    // Check if any action type matches
    for (const actionType of actionTypes) {
      if (observePlaybook.trigger.actionTypes.includes(actionType)) {
        return observePlaybook;
      }
    }

    return null;
  }

  private buildDefaultExecutor(): PlaybookExecutor {
    const executor = new PlaybookExecutor();
    executor.registerConnector(new SlackNotifyConnector({ webhookUrl: process.env['SLACK_WEBHOOK_URL'] }));
    executor.registerConnector(new GenericWebhookConnector());

    // Only register Jira if configured
    if (process.env['JIRA_BASE_URL'] && process.env['JIRA_EMAIL'] && process.env['JIRA_API_TOKEN']) {
      executor.registerConnector(new JiraIncidentConnector({
        baseUrl: process.env['JIRA_BASE_URL'],
        email: process.env['JIRA_EMAIL'],
        apiToken: process.env['JIRA_API_TOKEN'],
        projectKey: process.env['JIRA_PROJECT_KEY'] ?? 'SOC',
      }));
    }

    return executor;
  }
}
