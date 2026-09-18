/** SocTenantConfig zod schema per design §12. */
import { z } from 'zod';

const SignalSourceSchema = z.object({
  name: z.string().min(1),
  apiKeyRef: z.string().min(1),
  allowedIps: z.array(z.string()).optional(),
});

const LogSourceSchema = z.object({
  type: z.enum(['elasticsearch', 'splunk', 'cloudwatch']),
  endpoint: z.string().url(),
  credentialRef: z.string().min(1),
  index: z.string().optional(),
});

const ApprovalPolicyRefSchema = z.object({
  autoApprove: z.object({
    categories: z.array(z.enum(['observe', 'contain', 'eradicate', 'recover'])),
    maxSeverityForAuto: z.enum(['critical', 'high', 'medium', 'low', 'info']).default('high'),
    requireMinConfidence: z.number().min(0).max(1).default(0.8),
    allowedActionTypes: z.array(z.string()),
  }),
  manualApproval: z.object({
    channel: z.enum(['slack', 'pagerduty', 'email']),
    timeout: z.string().default('15m'),
    escalation: z.object({
      after: z.string(),
      to: z.string(),
    }),
    quorum: z.number().int().positive().default(1),
  }),
  blocked: z.array(z.string()),
});

const NotificationChannelSchema = z.object({
  channel: z.string().min(1),
  pagerdutyService: z.string().optional(),
  mentions: z.array(z.string()).optional(),
});

export const SocTenantConfigSchema = z.object({
  signalSources: z.array(SignalSourceSchema).min(1),
  logSource: LogSourceSchema,
  approvalPolicy: ApprovalPolicyRefSchema,
  enabledPlaybooks: z.array(z.string()),
  notifications: z.object({
    critical: NotificationChannelSchema,
    high: NotificationChannelSchema,
    approval: NotificationChannelSchema.extend({
      mentions: z.array(z.string()),
    }),
  }),
});

export type SocTenantConfig = z.infer<typeof SocTenantConfigSchema>;

/**
 * Parse and validate a raw tenant SOC config object.
 * Throws ZodError on invalid input.
 */
export function parseSocTenantConfig(raw: unknown): SocTenantConfig {
  return SocTenantConfigSchema.parse(raw);
}
