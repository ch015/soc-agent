export { createSocAgent, type SocAgent, type SocAgentOptions, type SocDataSource, type SocModel, type SocRunResult } from './api/agent.js';
export { SocSignalSchema, type SocSignal } from './runtime/investigation/signal.js';
export { SocLlmClient, type LlmClientOptions, type Message, type ToolDefinition } from './runtime/investigation/llm-client.js';
export { createHttpToolConnector, type InvestigationConnector } from './runtime/investigation/investigation-connector.js';
export type { Assessment, AssessmentGuard } from './runtime/investigation/investigation-policy.js';
export type { InvestigationRun, Observation } from './runtime/investigation/agent-loop.js';
export { investigateSignal } from './runtime/missions/investigate-signal.js';
