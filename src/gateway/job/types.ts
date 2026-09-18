/** Core types for the gateway job model. */
import { z } from 'zod';

export type DomainType = 'soc';

export type JobStatus =
  | 'rejected'
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'action_pending'
  | 'action_executing';

export interface AttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  downloadUrl: string;
}

export interface CanonicalSource {
  type: 'files' | 'git' | 'snapshot';
  attachments?: AttachmentRef[];
  repoUrl?: string;
  snapshotPath?: string;
}

export interface ResultCallback {
  type: 'slack_thread' | 'webhook' | 'poll' | 'pagerduty' | 'incident';
  /** Slack-specific */
  channel?: string;
  threadTs?: string;
  /** Webhook-specific */
  url?: string;
  headers?: Record<string, string>;
}

export const CanonicalSourceSchema = z.object({
  type: z.enum(['files', 'git', 'snapshot']),
  attachments: z.array(z.object({
    id: z.string(),
    name: z.string(),
    mimeType: z.string(),
    size: z.number(),
    downloadUrl: z.string(),
  })).optional(),
  repoUrl: z.string().optional(),
  snapshotPath: z.string().optional(),
});

export const ResultCallbackSchema = z.object({
  type: z.enum(['slack_thread', 'webhook', 'poll', 'pagerduty', 'incident']),
  channel: z.string().optional(),
  threadTs: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const CanonicalRequestSchema = z.object({
  domain: z.literal('soc'),
  source: CanonicalSourceSchema,
  instruction: z.string().min(1),
  options: z.record(z.string(), z.unknown()).optional(),
  callback: ResultCallbackSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export interface CanonicalRequest {
  domain: DomainType;
  source: CanonicalSource;
  instruction: string;
  options?: Record<string, unknown>;
  callback: ResultCallback;
  metadata?: Record<string, unknown>;
}

export interface Job {
  id: string;
  tenantId: string;
  domain: DomainType;
  status: JobStatus;
  priority: number;
  input: CanonicalRequest;
  callback: ResultCallback;
  progress: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  pendingInput: Record<string, unknown> | null;
  costUsd: number | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface ProgressEvent {
  jobId: string;
  phase: string;
  percent: number;
  detail?: string;
}

export interface JobEvent {
  id: number;
  jobId: string;
  eventType: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface ResultPayload {
  type: 'clarification' | 'completed' | 'failed' | 'cancelled' | 'progress';
  summary?: string;
  reportUrl?: string;
  questions?: string[];
  error?: string;
  phase?: string;
  percent?: number;
}
