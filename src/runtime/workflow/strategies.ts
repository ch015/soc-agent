import type {
  ExecutionStrategy,
  ProviderCapability,
  WorkflowContract,
  WorkflowPhase,
} from '../contracts/workflow-contract.js';
import { assertProviderCapabilities, type ProviderRuntime } from '../providers/provider-runtime.js';

const STRATEGY_CAPABILITIES: Readonly<Record<ExecutionStrategy, readonly ProviderCapability[]>> = {
  single: [],
  'prompt-chain': ['structured-output'],
  route: ['structured-output'],
  parallel: ['parallel-workers'],
  'manager-workers': ['agents-as-tools', 'parallel-workers'],
  'evaluator-optimizer': ['structured-output'],
  handoff: ['handoff'],
};

export type StrategyPlan = Readonly<{
  strategy: ExecutionStrategy;
  outerController: 'host';
  inPhaseCoordinator: 'host' | 'model';
  maxProviderCalls: number;
  maxFanout: number;
  requiredCapabilities: readonly ProviderCapability[];
}>;

export function compileStrategyPlan(
  contract: WorkflowContract,
  phase: WorkflowPhase,
): StrategyPlan {
  const maxIterations = phase.maxIterations ?? 1;
  if (maxIterations > Math.max(1, contract.limits.maxIterations)) {
    throw new Error(`${phase.id} maxIterations가 workflow 상한을 초과한다`);
  }
  const maxFanout = phase.maxFanout ?? 1;
  const maxProviderCalls =
    phase.strategy === 'evaluator-optimizer'
      ? 1 + maxIterations * 2
      : phase.strategy === 'parallel' || phase.strategy === 'manager-workers'
        ? 1 + maxFanout
        : 1;
  return Object.freeze({
    strategy: phase.strategy,
    outerController: 'host',
    inPhaseCoordinator: phase.controller === 'in-phase-model' ? 'model' : 'host',
    maxProviderCalls,
    maxFanout,
    requiredCapabilities: Object.freeze([...STRATEGY_CAPABILITIES[phase.strategy]]),
  });
}

export function assertStrategySupported(
  contract: WorkflowContract,
  phase: WorkflowPhase,
  runtime: Pick<ProviderRuntime, 'name' | 'capabilities'>,
): StrategyPlan {
  const plan = compileStrategyPlan(contract, phase);
  assertProviderCapabilities(runtime, plan.requiredCapabilities);
  return plan;
}

export function assertStrategyExecutable(phase: WorkflowPhase): void {
  if (phase.strategy !== 'single') {
    throw new Error(`${phase.id} ${phase.strategy} executor는 아직 등록되지 않았다`);
  }
}
