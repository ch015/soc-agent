import { z } from 'zod';

import { ContractResourceSchema } from './resource-manifest.js';

export const ExecutionStrategySchema = z.enum([
  'single',
  'prompt-chain',
  'route',
  'parallel',
  'manager-workers',
  'evaluator-optimizer',
  'handoff',
]);

export const ProviderCapabilitySchema = z.enum([
  'structured-output',
  'strict-tool-input',
  'local-mcp',
  'approvals',
  'resume',
  'trace',
  'agents-as-tools',
  'handoff',
  'parallel-workers',
  'sandbox',
  'tool-policy',
]);

const WorkflowRoleSchema = z.object({
  agentFile: z.string().min(1),
  description: z.string().min(1),
  tools: z.array(z.string().min(1)),
  skills: z.array(z.string().min(1)),
  allowedDelegates: z.array(z.string().min(1)),
  requiredCapabilities: z.array(ProviderCapabilitySchema),
}).strict();

const WorkflowPhaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
  role: z.string().min(1),
  requires: z.array(z.string().min(1)),
  controller: z.enum(['host', 'in-phase-model']),
  strategy: ExecutionStrategySchema,
  resultSchemaId: z.string().min(1),
  requiredMethodFiles: z.array(z.string().min(1)),
  requiredArtifacts: z.array(z.string().min(1)),
  optionalArtifacts: z.array(z.string().min(1)),
  approvals: z.array(z.string().min(1)),
  maxFanout: z.number().int().positive().optional(),
  maxIterations: z.number().int().positive().optional(),
}).strict();

export const WorkflowContractSchema = z.object({
  id: z.string().regex(/^nunchi\.[a-z0-9-]+\.[a-z0-9-]+$/),
  version: z.string().regex(/^1\.\d+\.\d+$/),
  domain: z.string().regex(/^[a-z0-9-]+$/),
  mission: z.string().regex(/^[a-z0-9-]+$/),
  lifecycle: z.enum(['finite', 'event-triggered']),
  forbiddenModelTools: z.array(z.string().min(1)),
  limits: z.object({
    maxBudgetUsd: z.number().positive().optional(),
    maxIterations: z.number().int().nonnegative(),
    maxSubagentDepth: z.number().int().nonnegative(),
  }).strict(),
  isolation: z.object({
    settingSources: z.array(z.string()),
    strictMcpConfig: z.boolean(),
    disableAutoMemory: z.boolean(),
    inheritParentSecrets: z.boolean(),
    sandboxRequired: z.boolean(),
    networkDefaultDeny: z.boolean(),
    permissionMode: z.enum(['default', 'dontAsk']),
  }).strict(),
  roles: z.record(z.string(), WorkflowRoleSchema),
  phases: z.array(WorkflowPhaseSchema).min(1),
  hostExecution: z.object({
    kind: z.literal('sealed-work-set'),
    entrypoint: z.string().regex(/^[a-z0-9-]+$/),
    workerPhases: z.array(z.string().min(1)).min(1),
    maximumWorkUnits: z.number().int().positive(),
    maximumConcurrency: z.number().int().positive(),
    completionBarrier: z.literal('all-settled-all-required'),
    directPhaseExecution: z.literal('forbidden'),
  }).strict().optional(),
  resources: z.array(ContractResourceSchema).min(1),
  failurePolicy: z.object({
    validationFailure: z.enum(['fail', 'block']),
  }).strict().default({ validationFailure: 'fail' }),
  publication: z.object({
    phase: z.string().min(1),
    draftArtifact: z.string().min(1),
    finalArtifact: z.string().min(1),
  }).strict().optional(),
}).strict();

export type WorkflowContract = z.infer<typeof WorkflowContractSchema>;
export type WorkflowPhase = WorkflowContract['phases'][number];
export type WorkflowRole = WorkflowContract['roles'][string];
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;
export type ExecutionStrategy = z.infer<typeof ExecutionStrategySchema>;

const IN_PHASE_MODEL_STRATEGIES = new Set<ExecutionStrategy>(['route', 'manager-workers', 'handoff']);

export function parseWorkflowContract(value: unknown): WorkflowContract {
  const contract = WorkflowContractSchema.parse(value);
  const expectedId = `nunchi.${contract.domain}.${contract.mission}`;
  if (contract.id !== expectedId) {
    throw new Error(`workflow contract id가 domain/mission과 다르다: ${contract.id} != ${expectedId}`);
  }
  if (
    contract.isolation.settingSources.length > 0 ||
    !contract.isolation.strictMcpConfig ||
    !contract.isolation.disableAutoMemory ||
    contract.isolation.inheritParentSecrets ||
    !contract.isolation.sandboxRequired ||
    !contract.isolation.networkDefaultDeny ||
    contract.isolation.permissionMode !== 'dontAsk'
  ) {
    throw new Error('workflow contract가 secure isolation baseline을 충족하지 않는다');
  }
  const phaseIds = new Set(contract.phases.map((phase) => phase.id));
  if (phaseIds.size !== contract.phases.length) throw new Error('workflow phase id가 중복됐다');
  for (const phase of contract.hostExecution?.workerPhases ?? []) {
    if (!phaseIds.has(phase)) throw new Error(`host work-set worker phase가 없다: ${phase}`);
  }

  for (const [name, role] of Object.entries(contract.roles)) {
    if (new Set(role.tools).size !== role.tools.length) throw new Error(`${name} tools가 중복됐다`);
    if (new Set(role.skills).size !== role.skills.length) throw new Error(`${name} skills가 중복됐다`);
    for (const delegate of role.allowedDelegates) {
      if (!contract.roles[delegate]) throw new Error(`${name} delegate가 roles에 없다: ${delegate}`);
    }
    const forbidden = role.tools.filter((tool) => contract.forbiddenModelTools.includes(tool));
    if (forbidden.length > 0) throw new Error(`${name}에 금지 도구가 있다: ${forbidden.join(', ')}`);
  }

  for (const phase of contract.phases) {
    if (!contract.roles[phase.role]) throw new Error(`${phase.id} role이 없다: ${phase.role}`);
    for (const required of phase.requires) {
      if (!phaseIds.has(required)) throw new Error(`${phase.id} dependency가 없다: ${required}`);
    }
    const artifacts = [...phase.requiredArtifacts, ...phase.optionalArtifacts];
    if (new Set(artifacts).size !== artifacts.length) throw new Error(`${phase.id} artifact가 중복됐다`);
    if (phase.controller === 'in-phase-model' && !IN_PHASE_MODEL_STRATEGIES.has(phase.strategy)) {
      throw new Error(`${phase.id}의 ${phase.strategy} 전략은 in-phase model coordinator를 허용하지 않는다`);
    }
    if (
      phase.controller === 'in-phase-model' &&
      contract.roles[phase.role]?.allowedDelegates.length === 0
    ) {
      throw new Error(`${phase.id} in-phase model coordinator에 delegate가 없다`);
    }
    if (
      (phase.strategy === 'parallel' || phase.strategy === 'manager-workers') &&
      phase.maxFanout === undefined
    ) {
      throw new Error(`${phase.id} ${phase.strategy}에 maxFanout이 없다`);
    }
    if (phase.strategy === 'evaluator-optimizer' && phase.maxIterations === undefined) {
      throw new Error(`${phase.id} evaluator-optimizer에 maxIterations가 없다`);
    }
  }

  assertAcyclic(contract.phases);
  if (contract.publication) {
    const phase = contract.phases.find((candidate) => candidate.id === contract.publication?.phase);
    if (!phase) throw new Error(`publication phase가 없다: ${contract.publication.phase}`);
    if (!phase.requiredArtifacts.includes(contract.publication.draftArtifact)) {
      throw new Error('publication draft가 필수 artifact가 아니다');
    }
    if (contract.publication.draftArtifact === contract.publication.finalArtifact) {
      throw new Error('publication draft와 final artifact가 같다');
    }
  }
  return contract;
}

function assertAcyclic(phases: WorkflowPhase[]): void {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`workflow phase dependency cycle: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.requires ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const phase of phases) visit(phase.id);
}

export function getWorkflowPhase(contract: WorkflowContract, id: string): WorkflowPhase {
  const phase = contract.phases.find((candidate) => candidate.id === id);
  if (!phase) throw new Error(`알 수 없는 workflow phase: ${contract.domain}.${id}`);
  return phase;
}

export function assertWorkflowPrerequisites(
  phase: WorkflowPhase,
  completed: ReadonlySet<string>,
): void {
  const missing = phase.requires.filter((required) => !completed.has(required));
  if (missing.length > 0) {
    throw new Error(`${phase.id} phase 선행 계약이 충족되지 않았다: ${missing.join(', ')}`);
  }
}
