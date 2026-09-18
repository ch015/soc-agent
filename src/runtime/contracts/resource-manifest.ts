import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';

import { z } from 'zod';

export const ContractResourceSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type ContractResource = z.infer<typeof ContractResourceSchema>;

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export function contractResourceSha256(content: string | Buffer): string {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  if (bytes.includes(0x0d)) {
    throw new Error('contract text resource는 LF 줄바꿈이어야 한다');
  }
  return sha256(bytes);
}

export function normalizeResourcePath(value: string): string {
  const candidate = value.replaceAll('\\', '/');
  const normalized = posix.normalize(candidate);
  if (
    candidate.length === 0 ||
    candidate.includes('\0') ||
    isAbsolute(candidate) ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/')
  ) {
    throw new Error(`contract resource 경로가 안전하지 않다: ${value}`);
  }
  return normalized;
}

export function assertExactResourceSet(
  resources: readonly ContractResource[],
  expectedPaths: readonly string[],
  label: string,
): ContractResource[] {
  const normalizedResources = resources.map((resource) => ({
    ...resource,
    path: normalizeResourcePath(resource.path),
  }));
  const declared = normalizedResources.map((resource) => resource.path);
  const expected = [...new Set(expectedPaths.map(normalizeResourcePath))];
  if (new Set(declared).size !== declared.length) {
    throw new Error(`${label} contract resource 경로가 중복됐다`);
  }
  const declaredSet = new Set(declared);
  const expectedSet = new Set(expected);
  const missing = expected.filter((path) => !declaredSet.has(path));
  const unexpected = declared.filter((path) => !expectedSet.has(path));
  if (missing.length > 0 || unexpected.length > 0 || declared.length !== expected.length) {
    throw new Error(
      `${label} contract resource 집합이 다르다: missing=${missing.join(',') || '-'} unexpected=${unexpected.join(',') || '-'}`,
    );
  }
  return normalizedResources;
}

export function validateResourceManifest(input: {
  resources: readonly ContractResource[];
  expectedPaths: readonly string[];
  root: string;
  label: string;
}): ContractResource[] {
  const resources = assertExactResourceSet(input.resources, input.expectedPaths, input.label);
  const root = resolve(input.root);
  for (const resource of resources) {
    const path = resolve(root, resource.path);
    const escaped = relative(root, path);
    if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
      throw new Error(`${input.label} contract resource가 root 밖이다: ${resource.path}`);
    }
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`${input.label} contract resource가 없다: ${resource.path}`);
    }
    const observed = contractResourceSha256(readFileSync(path));
    if (observed !== resource.sha256) {
      throw new Error(`${input.label} contract resource digest가 다르다: ${resource.path}`);
    }
  }
  return resources;
}
