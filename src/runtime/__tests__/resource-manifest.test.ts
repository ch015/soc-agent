import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assertExactResourceSet,
  contractResourceSha256,
  normalizeResourcePath,
  sha256,
  validateResourceManifest,
} from '../contracts/resource-manifest.js';

describe('contract resource manifest', () => {
  it('normalizes safe paths and rejects traversal', () => {
    expect(normalizeResourcePath('./agents/../agents/worker.md')).toBe('agents/worker.md');
    expect(() => normalizeResourcePath('../outside.md')).toThrow(/안전하지 않다/);
    expect(() => normalizeResourcePath('/outside.md')).toThrow(/안전하지 않다/);
    expect(() => normalizeResourcePath('agents\\worker.md')).not.toThrow();
  });

  it('requires an exact declared set without duplicate or orphan resources', () => {
    const resources = [{ path: 'worker.md', sha256: 'a'.repeat(64) }];
    expect(assertExactResourceSet(resources, ['worker.md', './worker.md'], 'test')).toEqual(resources);
    expect(() => assertExactResourceSet([...resources, ...resources], ['worker.md'], 'test')).toThrow(/중복/);
    expect(() => assertExactResourceSet(resources, ['other.md'], 'test')).toThrow(/집합/);
  });

  it('fails closed on missing files and post-pin content mutation', () => {
    const root = mkdtempSync(join(tmpdir(), 'nunchi-resource-manifest-'));
    const file = join(root, 'worker.md');
    writeFileSync(file, 'trusted worker');
    const resource = { path: 'worker.md', sha256: sha256('trusted worker') };
    expect(validateResourceManifest({ resources: [resource], expectedPaths: ['worker.md'], root, label: 'test' })).toEqual([resource]);
    writeFileSync(file, 'mutated worker');
    expect(() => validateResourceManifest({ resources: [resource], expectedPaths: ['worker.md'], root, label: 'test' })).toThrow(/digest/);
    expect(() => validateResourceManifest({ resources: [resource], expectedPaths: ['missing.md'], root, label: 'test' })).toThrow(/집합/);
  });

  it('requires LF contract text while continuing to reject content changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'nunchi-resource-eol-'));
    const file = join(root, 'worker.md');
    const trusted = 'trusted\nworker\n';
    const resource = { path: 'worker.md', sha256: contractResourceSha256(trusted) };
    writeFileSync(file, trusted);
    expect(validateResourceManifest({ resources: [resource], expectedPaths: ['worker.md'], root, label: 'test' }))
      .toEqual([resource]);
    writeFileSync(file, trusted.replaceAll('\n', '\r\n'));
    expect(() => validateResourceManifest({ resources: [resource], expectedPaths: ['worker.md'], root, label: 'test' }))
      .toThrow(/LF/);
    writeFileSync(file, 'trusted\nattacker\n');
    expect(() => validateResourceManifest({ resources: [resource], expectedPaths: ['worker.md'], root, label: 'test' }))
      .toThrow(/digest/);
  });
});
