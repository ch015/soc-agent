import { investigateSignal } from '../runtime/missions/investigate-signal.js';
import { SocSignalSchema, type SocSignal } from '../runtime/investigation/signal.js';
import type { SocLlmClient } from '../runtime/investigation/llm-client.js';
import type { InvestigationConnector } from '../runtime/investigation/investigation-connector.js';

export type SocModel = Pick<SocLlmClient, 'completeTurn'>;
export type SocDataSource =
  | { kind: 'nunchi-core' | 'http-json'; baseUrl: string; token: string; fetchImpl?: typeof fetch }
  | { createConnector(signal: Readonly<SocSignal>): InvestigationConnector };
export type SocAgentOptions = {
  llm: SocModel;
  dataSource: SocDataSource;
  capabilities?: string[];
  context?: string;
  limits?: { maxTurns?: number; maxToolCalls?: number; timeoutMs?: number; maxTotalTokens?: number };
};
export type SocRunResult = Awaited<ReturnType<typeof investigateSignal>>;

/** The application owns model access and backend mapping; the agent chooses its next action. */
export function createSocAgent(options: SocAgentOptions) {
  const settings = { ...options, dataSource: { ...options.dataSource }, limits: { ...options.limits },
    capabilities: options.capabilities ? [...options.capabilities] : undefined };
  return {
    async run(signalInput: SocSignal, execution: { signal?: AbortSignal; context?: string } = {}): Promise<SocRunResult> {
      execution.signal?.throwIfAborted();
      const signal = SocSignalSchema.parse(signalInput);
      const source = settings.dataSource;
      const connection = 'createConnector' in source
        ? { connector: source.createConnector(signal) }
        : { connector: source.kind, baseUrl: source.baseUrl, token: source.token };
      return investigateSignal({ signal, context: execution.context ?? settings.context,
        ...connection, ...settings.limits, capabilities: settings.capabilities },
      { llm: settings.llm, signal: execution.signal, ...('fetchImpl' in source ? { fetchImpl: source.fetchImpl } : {}) });
    },
  };
}
export type SocAgent = ReturnType<typeof createSocAgent>;
