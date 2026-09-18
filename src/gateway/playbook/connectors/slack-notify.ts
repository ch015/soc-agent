/** Slack notification connector — sends alerts to Slack channels. */
import type { ActionConnector, ActionResult, PlaybookStep, ExecutionContext } from '../types.js';

export class SlackNotifyConnector implements ActionConnector {
  readonly id = 'slack-notify';
  readonly supportedActions = ['notify-team', 'notify-channel', 'notify-oncall'];

  private readonly webhookUrl: string;
  private readonly botToken?: string;

  constructor(opts: { webhookUrl?: string; botToken?: string }) {
    this.webhookUrl = opts.webhookUrl ?? '';
    this.botToken = opts.botToken;
  }

  async execute(step: PlaybookStep, context: ExecutionContext): Promise<ActionResult> {
    const channel = (step.params?.channel as string) ?? step.target;
    const message = buildSlackMessage(step, context);

    try {
      if (this.botToken) {
        // Use Bot Token API
        const response = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.botToken}`,
          },
          body: JSON.stringify({
            channel,
            text: message.text,
            blocks: message.blocks,
          }),
        });

        const result = await response.json() as { ok: boolean; error?: string };
        if (!result.ok) {
          return {
            success: false,
            affectedEntities: [],
            details: { error: result.error, channel },
            rollbackCapable: false,
          };
        }
      } else if (this.webhookUrl) {
        // Use incoming webhook
        const response = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: message.text, blocks: message.blocks }),
        });

        if (!response.ok) {
          return {
            success: false,
            affectedEntities: [],
            details: { status: response.status, channel },
            rollbackCapable: false,
          };
        }
      } else {
        return {
          success: false,
          affectedEntities: [],
          details: { error: 'No Slack webhook URL or bot token configured' },
          rollbackCapable: false,
        };
      }

      return {
        success: true,
        affectedEntities: [channel],
        details: { channel, messageType: step.action },
        rollbackCapable: false, // Notifications cannot be rolled back
      };
    } catch (err) {
      return {
        success: false,
        affectedEntities: [],
        details: { error: err instanceof Error ? err.message : String(err) },
        rollbackCapable: false,
      };
    }
  }

  async healthCheck(): Promise<boolean> {
    return !!(this.webhookUrl || this.botToken);
  }
}

function buildSlackMessage(
  step: PlaybookStep,
  context: ExecutionContext,
): { text: string; blocks: unknown[] } {
  const severityEmoji: Record<string, string> = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🔵',
    info: 'ℹ️',
  };

  const emoji = severityEmoji[context.severity] ?? '⚠️';
  const text = `${emoji} [${context.severity.toUpperCase()}] Security Alert — Job ${context.jobId}`;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} Security Alert` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Severity:*\n${context.severity}` },
        { type: 'mrkdwn', text: `*Job:*\n${context.jobId}` },
        { type: 'mrkdwn', text: `*Signal:*\n${context.signalId}` },
        { type: 'mrkdwn', text: `*Action:*\n${step.action}` },
      ],
    },
  ];

  return { text, blocks };
}
