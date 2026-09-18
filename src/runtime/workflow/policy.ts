import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type ToolPolicy = Readonly<{
  contractId: string;
  domain: string;
  phase: string;
  role: string;
  targetDir: string;
  engagementDir: string;
  allowedTools: ReadonlySet<string>;
  allowedReadRoots: readonly string[];
  allowImplicitRootRead: boolean;
  /** Additional exact canonical files available outside allowedReadRoots. */
  allowedReadFiles?: ReadonlySet<string>;
  allowedMethodFiles: ReadonlySet<string>;
  allowedArtifacts: ReadonlySet<string>;
  allowedDelegates: ReadonlySet<string>;
}>;

export type ToolCall = Readonly<{
  tool: string;
  input: Readonly<Record<string, unknown>> | null;
  agentType?: string;
}>;

export type PolicyDecision = Readonly<{
  decision: 'allow' | 'deny';
  reason: string;
  updatedInput?: Readonly<Record<string, unknown>>;
}>;

export function canonicalPotentialPath(filePath: string, cwd: string): string {
  const absolute = resolve(cwd, filePath);
  let existing = absolute;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  return resolve(realpathSync(existing), relative(existing, absolute));
}

function isWithinDirectory(filePath: string, directory: string, cwd: string): boolean {
  const candidate = canonicalPotentialPath(filePath, cwd);
  const root = canonicalPotentialPath(directory, cwd);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function normalizedAgentName(agentType: string): string {
  return agentType.split(':').pop() ?? agentType;
}

function isAllowedDelegate(delegate: string, allowed: ReadonlySet<string>): boolean {
  return allowed.has(delegate) || allowed.has(normalizedAgentName(delegate));
}

export function createToolPolicy(input: Omit<ToolPolicy, 'allowedMethodFiles' | 'allowedReadFiles' | 'allowImplicitRootRead'> & {
  allowedMethodFiles: Iterable<string>;
  allowedReadFiles?: Iterable<string>;
  allowImplicitRootRead?: boolean;
}): ToolPolicy {
  if (!input.contractId || !input.phase || !input.role) {
    throw new Error('도구 정책에는 contract, phase, role이 필요하다');
  }
  const { allowedReadFiles, ...base } = input;
  return Object.freeze({
    ...base,
    allowedTools: new Set(input.allowedTools),
    allowedReadRoots: Object.freeze([...input.allowedReadRoots]),
    allowImplicitRootRead: input.allowImplicitRootRead ?? true,
    ...(allowedReadFiles
      ? {
          allowedReadFiles: new Set(
            [...allowedReadFiles].map((path) => canonicalPotentialPath(path, input.targetDir)),
          ),
        }
      : {}),
    allowedMethodFiles: new Set(
      [...input.allowedMethodFiles].map((path) => canonicalPotentialPath(path, input.targetDir)),
    ),
    allowedArtifacts: new Set(input.allowedArtifacts),
    allowedDelegates: new Set(input.allowedDelegates),
  });
}

export function authorizeToolCall(policy: ToolPolicy, call: ToolCall): PolicyDecision {
  if (call.agentType && normalizedAgentName(call.agentType) !== policy.role) {
    return {
      decision: 'deny',
      reason: `현재 phase role과 호출 agent가 다르다: ${policy.role} != ${call.agentType}`,
    };
  }
  // outputFormat이 활성화되면 SDK가 최종 응답을 이 내부 도구로 제출한다.
  // 호스트가 뒤에서 같은 JSON schema를 다시 검증하므로 별도 분석 권한을 부여하지 않는다.
  if (call.tool === 'StructuredOutput') {
    return { decision: 'allow', reason: 'SDK structured-output terminator' };
  }
  if (!policy.allowedTools.has(call.tool)) {
    return {
      decision: 'deny',
      reason: `${call.tool}은 ${policy.domain}.${policy.phase}/${policy.role} 계약 도구가 아니다`,
    };
  }

  if (['Read', 'Grep', 'Glob'].includes(call.tool)) {
    const readPath = call.tool === 'Read' ? call.input?.file_path : call.input?.path;
    const globPattern = call.tool === 'Glob' ? call.input?.pattern : undefined;
    const safeGlobPattern =
      call.tool !== 'Glob' ||
      (typeof globPattern === 'string' &&
        !isAbsolute(globPattern) &&
        !globPattern.split(/[\\/]+/).includes('..'));
    const implicitRootRead =
      policy.allowImplicitRootRead &&
      (call.tool === 'Grep' || call.tool === 'Glob') &&
      readPath === undefined &&
      safeGlobPattern;
    const exactRead =
      policy.allowedReadFiles !== undefined &&
      typeof readPath === 'string' &&
      policy.allowedReadFiles.has(canonicalPotentialPath(readPath, policy.targetDir));
    const allowedRootRead =
      safeGlobPattern &&
      (implicitRootRead ||
        (typeof readPath === 'string' &&
          policy.allowedReadRoots.some((root) =>
            isWithinDirectory(readPath, root, policy.targetDir),
          )));
    const allowedMethodRead =
      call.tool === 'Read' &&
      typeof readPath === 'string' &&
      policy.allowedMethodFiles.has(canonicalPotentialPath(readPath, policy.targetDir));
    if (!exactRead && !allowedRootRead && !allowedMethodRead) {
      return {
        decision: 'deny',
        reason: `읽기는 계약의 root, exact allow-list, 현재 phase method만 허용된다: ${String(readPath)}`,
      };
    }
  }

  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(call.tool)) {
    const outputPath = call.input?.file_path ?? call.input?.path ?? call.input?.notebook_path;
    const outputName =
      typeof outputPath === 'string'
        ? relative(
            canonicalPotentialPath(policy.engagementDir, policy.targetDir),
            canonicalPotentialPath(outputPath, policy.targetDir),
          )
        : undefined;
    if (
      typeof outputPath !== 'string' ||
      outputName === undefined ||
      basename(outputName) !== outputName ||
      outputName.includes(sep) ||
      !policy.allowedArtifacts.has(outputName)
    ) {
      return {
        decision: 'deny',
        reason: `산출물 쓰기는 현재 phase 계약 파일만 허용된다: ${String(outputPath)}`,
      };
    }
  }

  if (call.tool === 'Agent' || call.tool === 'Task') {
    const delegate = call.input?.subagent_type;
    if (typeof delegate !== 'string' || !isAllowedDelegate(delegate, policy.allowedDelegates)) {
      return {
        decision: 'deny',
        reason: `${String(delegate)} 위임은 ${policy.role} 역할 계약에서 허용되지 않는다`,
      };
    }
    return {
      decision: 'allow',
      reason: '계약된 foreground 위임',
      updatedInput: Object.freeze({ ...call.input, run_in_background: false }),
    };
  }

  return { decision: 'allow', reason: '계약된 도구 호출' };
}
