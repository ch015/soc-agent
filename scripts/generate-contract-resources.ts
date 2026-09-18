import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  normalizeResourcePath,
  contractResourceSha256,
  type ContractResource,
} from '../src/runtime/contracts/resource-manifest.js';

const ROOT = resolve(import.meta.dirname, '..');
const check = process.argv.includes('--check');

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function resourcePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizeResourcePath))];
}

function resourcesFor(root: string, paths: readonly string[]): ContractResource[] {
  return resourcePaths(paths).map((path) => {
    const fullPath = join(root, path);
    if (!existsSync(fullPath)) throw new Error(`contract resource가 없다: ${fullPath}`);
    return { path, sha256: contractResourceSha256(readFileSync(fullPath)) };
  });
}

function updateContract(path: string, root: string, paths: readonly string[]): void {
  const current = readJson(path);
  const next = { ...current, resources: resourcesFor(root, paths) };
  if (check) {
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      throw new Error(`contract resource manifest가 최신이 아니다: ${relative(ROOT, path)}`);
    }
    return;
  }
  writeJson(path, next);
}

for (const mission of ['report', 'investigation'] as const) {
  const socRoot = join(ROOT, 'domains', 'soc');
  const contractPath = join(socRoot, 'contracts', `soc-${mission}-contract.v1.json`);
  const contract = readJson(contractPath);
  updateContract(
    contractPath,
    socRoot,
    [
      `contracts/soc-${mission}-source-schema.v1.json`,
      `contracts/soc-${mission}-result-schemas.v1.json`,
      ...Object.values(contract.roles).flatMap((role: any) => [
        role.agentFile,
        ...role.skills.map((skill: string) => `skills/${skill.split(':').pop()}/SKILL.md`),
      ]),
      ...contract.phases.flatMap((phase: any) => phase.requiredMethodFiles),
    ],
  );
}

console.log(check ? 'contract resource manifests: in sync' : 'contract resource manifests: generated');
