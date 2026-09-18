import { z } from 'zod';

// ─── Severity ───────────────────────────────────────────────────────────────

export const SocSeverity = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type SocSeverity = z.infer<typeof SocSeverity>;

// ─── Signal Schema (§4.1) ───────────────────────────────────────────────────

export const SocSignalSchema = z.object({
  signalId: z.string().min(1),
  signalType: z.enum(['alert', 'detection', 'anomaly', 'correlation']),
  source: z.string().min(1),
  severity: SocSeverity,
  timestamp: z.string().datetime(),

  // Analysis context
  subject: z.object({
    type: z.enum(['ip', 'user', 'host', 'service', 'domain', 'hash']),
    value: z.string().min(1),
  }),
  rule: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    category: z.string().min(1),
  }).optional(),

  // Time range hint
  timeContext: z.object({
    firstSeen: z.string().datetime(),
    lastSeen: z.string().datetime(),
    suggestedWindow: z.string().optional(),
  }).optional(),

  // Raw event references
  rawEvents: z.array(z.object({
    source: z.string(),
    eventId: z.string(),
    summary: z.string(),
  })).optional(),

  // Metadata
  tenantId: z.string().min(1),
  tags: z.array(z.string()).optional(),
});

export type SocSignal = z.infer<typeof SocSignalSchema>;

