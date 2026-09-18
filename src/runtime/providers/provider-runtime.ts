import type { ProviderCapability } from '../contracts/workflow-contract.js';
import type { ProviderUsage } from '../contracts/result-contract.js';
import type { CompactBoundaryMetadata } from '../session-types.js';

export type ProviderRuntimeEvent = {
  at: string;
  event: string;
  actor?: string;
  tool?: string;
  resource?: string;
  query?: string;
  decision?: 'allow' | 'deny';
  reason?: string;
  compaction?: CompactBoundaryMetadata;
};

export type ProviderPhaseRequest<TOptions = unknown> = {
  contractId: string;
  contractVersion: string;
  domain: string;
  mission: string;
  phase: string;
  role: string;
  runId: string;
  attempt: string;
  target: string;
  engagementDir: string;
  prompt: string;
  requiredCapabilities: ProviderCapability[];
  maxBudgetUsd?: number;
  allowedReadFiles?: readonly string[];
  options?: TOptions;
  onEvent?: (event: ProviderRuntimeEvent) => void;
};

export type ProviderPhaseOutcome<TRaw = unknown> = {
  provider: string;
  texts: string[];
  events: ProviderRuntimeEvent[];
  structuredOutput?: unknown;
  usage: ProviderUsage;
  registeredAgents?: Array<{ name: string; description: string; model?: string }>;
  raw: TRaw;
};

export interface ProviderRuntime<TOptions = unknown, TRaw = unknown> {
  readonly name: string;
  readonly capabilities: ReadonlySet<ProviderCapability>;
  runPhase(request: ProviderPhaseRequest<TOptions>): Promise<ProviderPhaseOutcome<TRaw>>;
}

export class ProviderRuntimeFailure extends Error {
  constructor(
    message: string,
    readonly usage?: ProviderUsage,
    options?: ErrorOptions,
    readonly events: ProviderRuntimeEvent[] = [],
  ) {
    super(message, options);
    this.name = 'ProviderRuntimeFailure';
  }
}

export function assertProviderCapabilities(
  runtime: Pick<ProviderRuntime, 'name' | 'capabilities'>,
  required: readonly ProviderCapability[],
): void {
  const missing = required.filter((capability) => !runtime.capabilities.has(capability));
  if (missing.length > 0) {
    throw new Error(`${runtime.name} provider capability가 부족하다: ${missing.join(', ')}`);
  }
}
