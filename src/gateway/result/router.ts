/** Result router — dispatches results by callback.type (slack_thread, webhook, poll, pagerduty, incident). */
import { AsyncLocalStorage } from 'node:async_hooks';
const deliveryContext = new AsyncLocalStorage<string>();
import type { Job, ResultPayload } from '../job/types.js';

/**
 * ResultHandler — handles result delivery for a specific callback type.
 */
export interface ResultHandler {
  readonly type: string;
  handle(job: Job, payload: ResultPayload): Promise<void>;
}

/**
 * ResultRouter — dispatches results by callback.type enum.
 * Register handlers for each callback type; the router dispatches accordingly.
 */
export class ResultRouter {
  private handlers = new Map<string, ResultHandler>();

  register(type: string, handler: ResultHandler): void {
    this.handlers.set(type, handler);
  }

  async route(job: Job, payload: ResultPayload, deliveryId?: string): Promise<void> {
    const callbackType = job.callback.type;
    const handler = this.handlers.get(callbackType);
    if (!handler) {
      throw new Error(`No result handler registered: ${callbackType}`);
    }
    await deliveryContext.run(deliveryId ?? '', () => handler.handle(job, payload));
  }
}

// ─── Built-in Handlers ──────────────────────────────────────────────────────

/**
 * Slack thread result handler — sends replies to the originating Slack thread.
 */
export class SlackThreadResultHandler implements ResultHandler {
  readonly type = 'slack_thread';

  constructor(private readonly getBotToken: () => string) {}

  async handle(job: Job, payload: ResultPayload): Promise<void> {
    const { sendResultReply } = await import('../adapters/slack/reply.js');
    await sendResultReply(this.getBotToken(), job, payload);
  }
}

/**
 * Webhook result handler — POSTs results to a configured URL.
 */
export class WebhookResultHandler implements ResultHandler {
  readonly type = 'webhook';

  async handle(job: Job, payload: ResultPayload): Promise<void> {
    const url = job.callback.url;
    if (!url) {
      throw new Error(`No webhook URL configured for job ${job.id}`);
    }

    const response = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        ...job.callback.headers,
        ...(deliveryContext.getStore() ? { 'Idempotency-Key': deliveryContext.getStore()! } : {}),
      },
      body: JSON.stringify({
        jobId: job.id,
        domain: job.domain,
        ...payload,
      }),
    });

    if (!response.ok) {
      throw new Error(`Callback HTTP ${response.status}`);
    }
  }
}

/**
 * Poll handler — no-op; results are stored in job.result and polled via GET.
 */
export class PollResultHandler implements ResultHandler {
  readonly type = 'poll';

  async handle(_job: Job, _payload: ResultPayload): Promise<void> {
    // No-op: poll-based clients read from GET /jobs/:id/result
  }
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const resultRouter = new ResultRouter();

/**
 * PagerDuty result handler — sends escalation events to PagerDuty.
 */
export class PagerDutyResultHandler implements ResultHandler {
  readonly type = 'pagerduty';

  async handle(job: Job, payload: ResultPayload): Promise<void> {
    const routingKey = process.env['PAGERDUTY_ROUTING_KEY'];
    if (!routingKey) {
      throw new Error(`No PAGERDUTY_ROUTING_KEY configured for job ${job.id}`);
    }

    const severity = payload.type === 'failed' ? 'critical' : 'warning';
    const event = {
      routing_key: routingKey,
      event_action: 'trigger',
      payload: {
        summary: payload.error ?? payload.summary ?? `SOC alert for job ${job.id}`,
        source: `nunchi-gateway:${job.domain}`,
        severity,
        custom_details: {
          jobId: job.id,
          tenantId: job.tenantId,
          domain: job.domain,
          payload,
        },
      },
    };

    const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      throw new Error(`PagerDuty HTTP ${response.status}`);
    }
  }
}

/**
 * Incident result handler — creates/updates incidents in the configured incident system.
 */
export class IncidentResultHandler implements ResultHandler {
  readonly type = 'incident';

  async handle(job: Job, payload: ResultPayload): Promise<void> {
    // Incident handling delegates to the webhook mechanism with incident-specific formatting.
    const incidentUrl = process.env['INCIDENT_WEBHOOK_URL'];
    if (!incidentUrl) {
      throw new Error(`No INCIDENT_WEBHOOK_URL configured for job ${job.id}`);
    }

    const response = await fetch(incidentUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        incidentType: 'soc_incident',
        jobId: job.id,
        tenantId: job.tenantId,
        domain: job.domain,
        severity: job.input?.options?.signal
          ? (job.input.options.signal as Record<string, unknown>).severity
          : 'unknown',
        ...payload,
      }),
    });

    if (!response.ok) {
      throw new Error(`Incident HTTP ${response.status}`);
    }
  }
}

/**
 * Initialize the result router with default handlers.
 */
export function initResultRouter(
  getBotToken: () => string,
): void {
  resultRouter.register('slack_thread', new SlackThreadResultHandler(getBotToken));
  resultRouter.register('webhook', new WebhookResultHandler());
  resultRouter.register('poll', new PollResultHandler());
  resultRouter.register('pagerduty', new PagerDutyResultHandler());
  resultRouter.register('incident', new IncidentResultHandler());
}
