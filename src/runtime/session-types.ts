import type { Options } from '@anthropic-ai/claude-agent-sdk';


export const DOMAINS = ['soc'] as const;
export type Domain = (typeof DOMAINS)[number];

export type SessionSpec = {
  domain: Domain;
  mission?: string;
  entryAgent?: string;
  agentRole?: string;
  phase?: string;
  phaseRound?: string;
  target: string;
  prompt: string;
  engagementDir: string;
  engagementId: string;
  model?: string;
  effort?: NonNullable<Options['effort']>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  networkAllowedDomains?: readonly string[];
  allowedReadFiles?: readonly string[];
  readScope?: 'default' | 'exact';
  disabledTools?: readonly string[];
  onLedger?: (row: LedgerRow) => void;
  onStderr?: (chunk: string) => void;
  onProgress?: (event: { kind: 'text' | 'tool'; from: string; detail: string }) => void;
  abortController?: AbortController;
};

export type CompactBoundaryMetadata = {
  trigger: 'manual' | 'auto';
  preTokens: number;
  postTokens?: number;
  durationMs?: number;
  boundaryId: string;
};

export type LedgerRow = {
  at: string;
  event: string;
  agentId?: string;
  agentType?: string;
  tool?: string;
  resource?: string;
  decision?: 'allow' | 'deny';
  reason?: string;
  query?: string;
  compaction?: CompactBoundaryMetadata;
};
