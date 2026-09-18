import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { z } from 'zod';

export const ArtifactRefSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  path: z.string().min(1),
  mediaType: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z.number().int().nonnegative(),
  producer: z.object({
    phase: z.string().min(1),
    role: z.string().min(1),
    attempt: z.string().min(1),
  }).strict(),
  schemaId: z.string().min(1).optional(),
}).strict();

export const DecisionRefSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['route', 'approval', 'transition']),
  proposal: z.string().min(1),
  decision: z.enum(['allow', 'deny', 'pending']),
  decidedBy: z.enum(['host-policy', 'human']),
  reason: z.string().min(1),
}).strict();

export const ProviderUsageSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1).optional(),
  modelIdentityVerified: z.boolean().optional(),
  turns: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative(),
  accountingComplete: z.boolean().optional(),
  raw: z.unknown().optional(),
}).strict();

export const PhaseResultEnvelopeSchema = z.object({
  contractId: z.string().min(1),
  contractVersion: z.string().min(1),
  runId: z.string().min(1),
  phase: z.string().min(1),
  role: z.string().min(1),
  attempt: z.string().min(1),
  status: z.enum(['complete', 'blocked']),
  artifacts: z.array(ArtifactRefSchema),
  decisions: z.array(DecisionRefSchema),
  domainPayload: z.unknown(),
  unresolved: z.array(z.string()),
  usage: ProviderUsageSchema,
}).strict();

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type PhaseResultEnvelope = z.infer<typeof PhaseResultEnvelopeSchema>;
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>;

export function createArtifactRef(input: {
  engagementDir: string;
  name: string;
  phase: string;
  role: string;
  attempt: string;
  schemaId?: string;
}): ArtifactRef {
  const root = resolve(input.engagementDir);
  const path = resolve(root, input.name);
  if (dirname(path) !== root || basename(path) !== input.name) {
    throw new Error(`artifact는 engagement 직속 파일이어야 한다: ${input.name}`);
  }
  if (!existsSync(path)) throw new Error(`artifact가 실제로 없다: ${path}`);
  const content = readFileSync(path);
  const sha256 = createHash('sha256').update(content).digest('hex');
  return ArtifactRefSchema.parse({
    id: `${input.phase}/${input.attempt}/${input.name}`,
    name: input.name,
    path,
    mediaType: mediaTypeFor(input.name),
    sha256,
    bytes: statSync(path).size,
    producer: { phase: input.phase, role: input.role, attempt: input.attempt },
    ...(input.schemaId ? { schemaId: input.schemaId } : {}),
  });
}

export function parsePhaseResultEnvelope(input: {
  value: unknown;
  identity: {
    contractId: string;
    contractVersion: string;
    runId: string;
    phase: string;
    role: string;
    attempt: string;
  };
}): PhaseResultEnvelope {
  const value = PhaseResultEnvelopeSchema.parse(input.value);
  for (const [key, expected] of Object.entries(input.identity)) {
    if (value[key as keyof typeof value] !== expected) {
      throw new Error(`phase result ${key} 불일치: ${String(value[key as keyof typeof value])} != ${expected}`);
    }
  }
  if (new Set(value.artifacts.map((artifact) => artifact.id)).size !== value.artifacts.length) {
    throw new Error('phase result artifact id가 중복됐다');
  }
  if (value.status === 'blocked' && value.unresolved.length === 0) {
    throw new Error('blocked phase result에는 unresolved 사유가 필요하다');
  }
  return value;
}

export function verifyArtifactRef(artifact: ArtifactRef, engagementDir: string): void {
  const root = resolve(engagementDir);
  const path = resolve(artifact.path);
  if (dirname(path) !== root || basename(path) !== artifact.name) {
    throw new Error(`artifact ref가 engagement 밖을 가리킨다: ${artifact.path}`);
  }
  if (!existsSync(path)) throw new Error(`artifact ref 파일이 없다: ${path}`);
  const content = readFileSync(path);
  const observed = createHash('sha256').update(content).digest('hex');
  if (observed !== artifact.sha256) throw new Error(`artifact hash가 다르다: ${artifact.name}`);
  if (content.byteLength !== artifact.bytes) throw new Error(`artifact 크기가 다르다: ${artifact.name}`);
}

export function verifyRunArtifactRef(artifact: ArtifactRef, runRoot: string): void {
  const root = resolve(runRoot);
  const artifactDir = dirname(resolve(artifact.path));
  const revision = relative(join(root, 'revisions'), artifactDir);
  const workUnit = relative(join(root, 'work-units'), artifactDir);
  if (
    artifactDir !== root &&
    !/^r\d{4}$/.test(revision) &&
    !/^unit-[a-f0-9]{16}(?:[\\/]attempt-[12])?$/.test(workUnit)
  ) {
    throw new Error(`artifact ref가 run의 봉인 디렉터리 밖을 가리킨다: ${artifact.path}`);
  }
  verifyArtifactRef(artifact, artifactDir);
}

function mediaTypeFor(name: string): string {
  if (name.endsWith('.md')) return 'text/markdown';
  if (name.endsWith('.json') || name.endsWith('.jsonl')) return 'application/json';
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return 'application/yaml';
  return 'application/octet-stream';
}
