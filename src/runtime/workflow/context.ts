export type HostControlContext = Readonly<{
  runId: string;
  contractId: string;
  contractVersion: string;
  domain: string;
  phase: string;
  role: string;
}>;

export type UntrustedTaskData = Readonly<{
  scope: string;
  inputs: Readonly<Record<string, unknown>>;
}>;

export type ModelTaskContext = Readonly<{
  control: HostControlContext;
  target: string;
  engagementDir: string;
  round?: string;
  requiredMethodFiles: readonly string[];
  requiredArtifacts: readonly string[];
  optionalArtifacts: readonly string[];
  untrusted: UntrustedTaskData;
}>;

export function buildModelTaskContext(input: {
  control: HostControlContext;
  target: string;
  engagementDir: string;
  round?: string;
  requiredMethodFiles: readonly string[];
  requiredArtifacts: readonly string[];
  optionalArtifacts: readonly string[];
  scope?: string;
  inputs?: Readonly<Record<string, unknown>>;
}): ModelTaskContext {
  const context: ModelTaskContext = {
    control: Object.freeze({ ...input.control }),
    target: input.target,
    engagementDir: input.engagementDir,
    ...(input.round ? { round: input.round } : {}),
    requiredMethodFiles: Object.freeze([...input.requiredMethodFiles]),
    requiredArtifacts: Object.freeze([...input.requiredArtifacts]),
    optionalArtifacts: Object.freeze([...input.optionalArtifacts]),
    untrusted: Object.freeze({
      scope: input.scope ?? '전체',
      inputs: Object.freeze({ ...(input.inputs ?? {}) }),
    }),
  };
  return Object.freeze(context);
}

export function renderModelTaskContext(context: ModelTaskContext): string[] {
  return [
    `[WORKFLOW CONTRACT ${context.control.contractId}@${context.control.contractVersion}]`,
    `host_control: ${JSON.stringify({
      runId: context.control.runId,
      domain: context.control.domain,
      phase: context.control.phase,
      role: context.control.role,
    })}`,
    `target_read_only_data: ${JSON.stringify(context.target)}`,
    `engagement_dir_data: ${JSON.stringify(context.engagementDir)}`,
    context.round ? `round: ${JSON.stringify(context.round)}` : '',
    `required_method_files: ${JSON.stringify(context.requiredMethodFiles)}`,
    `required_artifacts: ${JSON.stringify(context.requiredArtifacts)}`,
    `optional_artifacts: ${JSON.stringify(context.optionalArtifacts)}`,
    '<untrusted_task_data>',
    `scope: ${renderUntrustedJson(context.untrusted.scope)}`,
    `inputs: ${renderUntrustedJson(context.untrusted.inputs)}`,
    '</untrusted_task_data>',
  ].filter(Boolean);
}

function renderUntrustedJson(value: unknown): string {
  return (JSON.stringify(value) ?? 'null').replace(/[<>&]/g, (character) => {
    const code = character.codePointAt(0)?.toString(16).padStart(4, '0') ?? '0000';
    return `\\u${code}`;
  });
}
