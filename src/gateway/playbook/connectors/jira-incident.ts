/** Jira incident creation connector. */
import type { ActionConnector, ActionResult, PlaybookStep, ExecutionContext } from '../types.js';

export class JiraIncidentConnector implements ActionConnector {
  readonly id = 'jira-incident';
  readonly supportedActions = ['create-incident', 'update-incident', 'close-incident'];

  private readonly baseUrl: string;
  private readonly email: string;
  private readonly apiToken: string;
  private readonly projectKey: string;

  constructor(opts: {
    baseUrl: string;
    email: string;
    apiToken: string;
    projectKey: string;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.email = opts.email;
    this.apiToken = opts.apiToken;
    this.projectKey = opts.projectKey;
  }

  async execute(step: PlaybookStep, context: ExecutionContext): Promise<ActionResult> {
    switch (step.action) {
      case 'create-incident':
        return this.createIncident(step, context);
      case 'update-incident':
        return this.updateIncident(step, context);
      case 'close-incident':
        return this.closeIncident(step, context);
      default:
        return {
          success: false,
          affectedEntities: [],
          details: { error: `Unsupported action: ${step.action}` },
          rollbackCapable: false,
        };
    }
  }

  async rollback?(step: PlaybookStep, context: ExecutionContext): Promise<ActionResult> {
    // Close/cancel the created incident
    if (step.action === 'create-incident') {
      const ticketKey = (step.params?.createdTicketKey as string) ?? '';
      if (ticketKey) {
        return this.transitionIssue(ticketKey, 'Cancelled', context);
      }
    }
    return {
      success: false,
      affectedEntities: [],
      details: { error: 'Cannot rollback: no ticket key available' },
      rollbackCapable: false,
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/rest/api/3/myself`, {
        headers: this.buildHeaders(),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async createIncident(step: PlaybookStep, context: ExecutionContext): Promise<ActionResult> {
    const summary = (step.params?.summary as string)
      ?? `[SOC] Security Incident - ${context.severity.toUpperCase()} - Signal ${context.signalId}`;
    const description = (step.params?.description as string)
      ?? buildDescription(step, context);
    const priority = mapSeverityToJiraPriority(context.severity);

    try {
      const response = await fetch(`${this.baseUrl}/rest/api/3/issue`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          fields: {
            project: { key: this.projectKey },
            summary,
            description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }] },
            issuetype: { name: (step.params?.issueType as string) ?? 'Incident' },
            priority: { name: priority },
            labels: ['soc-auto', `severity-${context.severity}`],
          },
        }),
      });

      if (!response.ok) {
        const errBody = await response.text();
        return {
          success: false,
          affectedEntities: [],
          details: { status: response.status, error: errBody },
          rollbackCapable: false,
        };
      }

      const result = await response.json() as { key: string; id: string };
      return {
        success: true,
        affectedEntities: [result.key],
        details: { ticketKey: result.key, ticketId: result.id, url: `${this.baseUrl}/browse/${result.key}` },
        rollbackCapable: true,
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

  private async updateIncident(step: PlaybookStep, context: ExecutionContext): Promise<ActionResult> {
    const ticketKey = step.target;
    const comment = (step.params?.comment as string) ?? `Updated by SOC automation (job: ${context.jobId})`;

    try {
      const response = await fetch(`${this.baseUrl}/rest/api/3/issue/${ticketKey}/comment`, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({
          body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }] },
        }),
      });

      return {
        success: response.ok,
        affectedEntities: [ticketKey],
        details: { status: response.status },
        rollbackCapable: false,
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

  private async closeIncident(step: PlaybookStep, context: ExecutionContext): Promise<ActionResult> {
    return this.transitionIssue(step.target, 'Done', context);
  }

  private async transitionIssue(
    ticketKey: string,
    transitionName: string,
    _context: ExecutionContext,
  ): Promise<ActionResult> {
    try {
      // Get available transitions
      const transResponse = await fetch(
        `${this.baseUrl}/rest/api/3/issue/${ticketKey}/transitions`,
        { headers: this.buildHeaders() },
      );
      if (!transResponse.ok) {
        return { success: false, affectedEntities: [], details: { error: 'Failed to get transitions' }, rollbackCapable: false };
      }

      const transitions = await transResponse.json() as { transitions: Array<{ id: string; name: string }> };
      const target = transitions.transitions.find((t) => t.name === transitionName);
      if (!target) {
        return { success: false, affectedEntities: [], details: { error: `Transition "${transitionName}" not found` }, rollbackCapable: false };
      }

      const response = await fetch(
        `${this.baseUrl}/rest/api/3/issue/${ticketKey}/transitions`,
        {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify({ transition: { id: target.id } }),
        },
      );

      return {
        success: response.ok,
        affectedEntities: [ticketKey],
        details: { transition: transitionName, status: response.status },
        rollbackCapable: false,
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

  private buildHeaders(): Record<string, string> {
    const auth = Buffer.from(`${this.email}:${this.apiToken}`).toString('base64');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Basic ${auth}`,
    };
  }
}

function mapSeverityToJiraPriority(severity: string): string {
  switch (severity) {
    case 'critical': return 'Highest';
    case 'high': return 'High';
    case 'medium': return 'Medium';
    case 'low': return 'Low';
    default: return 'Low';
  }
}

function buildDescription(step: PlaybookStep, context: ExecutionContext): string {
  return [
    `SOC Automated Incident Report`,
    ``,
    `Job ID: ${context.jobId}`,
    `Signal ID: ${context.signalId}`,
    `Severity: ${context.severity}`,
    `Tenant: ${context.tenantId}`,
    `Target: ${step.target}`,
  ].join('\n');
}
