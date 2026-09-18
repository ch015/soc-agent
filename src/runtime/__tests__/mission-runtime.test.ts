import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InMemoryArtifactStore } from '../workflow/artifact-store.js';
import { createMissionRuntime } from '../workflow/mission-runtime.js';

describe('mission runtime backend boundary', () => {
  it('rejects an engagement that escapes the shared root through a symbolic link', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nunchi-mission-root-'));
    const sharedRoot = join(base, 'shared');
    const outsideRoot = join(base, 'outside');
    const outsideRun = join(outsideRoot, 'run');
    mkdirSync(sharedRoot);
    mkdirSync(outsideRun, { recursive: true });
    symlinkSync(outsideRoot, join(sharedRoot, 'escape'));
    const unreachablePool = {
      query: async () => { throw new Error('database must not be reached'); },
      connect: async () => { throw new Error('database must not be reached'); },
      end: async () => undefined,
    };

    try {
      await expect(createMissionRuntime({
        engagementDir: join(sharedRoot, 'escape', 'run'),
        runId: 'symlink-escape',
        contractId: 'test-contract',
        contractVersion: '1.0.0',
        domain: 'soc',
        mission: 'report',
      }, {
        backend: 'postgres',
        pool: unreachablePool as never,
        artifactStore: new InMemoryArtifactStore(),
        sharedEngagementRoot: sharedRoot,
      })).rejects.toThrow(/shared root 밖/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
