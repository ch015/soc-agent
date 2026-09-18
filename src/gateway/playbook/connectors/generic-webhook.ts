/** Generic webhook connector — POSTs action payloads to configurable endpoints. */
import type { ActionConnector, ActionResult, PlaybookStep, ExecutionContext } from '../types.js';

export class GenericWebhookConnector implements ActionConnector {
  readonly id = 'generic-webhook';
  readonly supportedActions = ['webhook', 'generic-webhook', 'http-call'];

  private readonly defaultHeaders: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(opts?: { defaultHeaders?: Record<string, string>; timeoutMs?: number }) {
    this.defaultHeaders = opts?.defaultHeaders ?? {};
    this.timeoutMs = opts?.timeoutMs ?? 30_000;
  }

  async execute(step: PlaybookStep, context: ExecutionContext): Promise<ActionResult> {
    const url = step.target;
    if (!url || !url.startsWith('http')) {
      return {
        success: false,
        affectedEntities: [],
        details: { error: 'Invalid webhook URL' },
        rollbackCapable: false,
      };
    }

    const method = (step.params?.method as string)?.toUpperCase() ?? 'POST';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.defaultHeaders,
      ...(step.params?.headers as Record<string, string> ?? {}),
    };

    const payload = {
      action: step.action,
      jobId: context.jobId,
      tenantId: context.tenantId,
      signalId: context.signalId,
      severity: context.severity,
      params: step.params,
      timestamp: new Date().toISOString(),
      ...(step.params?.body as Record<string, unknown> ?? {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method !== 'GET' ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });

      const responseBody = await response.text().catch(() => '');

      if (!response.ok) {
        return {
          success: false,
          affectedEntities: [url],
          details: {
            status: response.status,
            statusText: response.statusText,
            body: responseBody.slice(0, 500),
          },
          rollbackCapable: false,
        };
      }

      return {
        success: true,
        affectedEntities: [url],
        details: {
          status: response.status,
          body: responseBody.slice(0, 500),
        },
        rollbackCapable: false,
      };
    } catch (err) {
      return {
        success: false,
        affectedEntities: [],
        details: {
          error: err instanceof Error ? err.message : String(err),
          url,
        },
        rollbackCapable: false,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async healthCheck(): Promise<boolean> {
    // Generic webhook connector is always "healthy" — actual endpoint health
    // is determined at execution time.
    return true;
  }
}
