import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createArtifactRef } from '../contracts/result-contract.js';
import {
  inspectRun,
  reconcileIncompleteAttempt,
  resumeRunWithInput,
} from '../workflow/reconciliation.js';
import { InMemoryTelemetrySink } from '../workflow/telemetry.js';
import { FileRunStateStore } from '../workflow/state-store.js';

function createStore(runId: string) {
  const root = mkdtempSync(join(tmpdir(), `nunchi-reconcile-${runId}-`));
  const engagementDir = join(root, 'reports', runId);
  const state = FileRunStateStore.create({
    engagementDir,
    runId,
    contractId: 'nunchi.test.reconcile',
    contractVersion: '1.0.0',
    domain: 'offsec',
    mission: 'assessment',
  });
  return { root, engagementDir, state };
}

function writeArtifact(engagementDir: string, name: string, content: string, phase: string, attempt: string) {
  writeFileSync(join(engagementDir, name), content);
  return createArtifactRef({ engagementDir, name, phase, role: 'host', attempt });
}

function fileHash(path: string, content: string) {
  return { path, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) };
}

describe('reconciliation and telemetry', () => {
  it('inspects and explicitly reconciles an incomplete attempt without automatic rerun', async () => {
    const { state } = createStore('reconcile-run');
    state.append({ type: 'phase.started', eventId: 'reconcile-run:started', phase: 'scan', attempt: 1 });
    const before = await inspectRun(state);
    expect(before.incompleteAttempts).toEqual([{ phase: 'scan', attempt: 1, status: 'started' }]);
    const telemetry = new InMemoryTelemetrySink();

    const after = await reconcileIncompleteAttempt({
      state,
      expectedVersion: before.lastSeq,
      phase: 'scan',
      attempt: 1,
      reasonCode: 'provider-error',
      telemetry,
    });
    expect(after.attempts['scan:-:1']?.status).toBe('failed');
    expect((await inspectRun(state)).incompleteAttempts).toEqual([]);
    expect(telemetry.list()[0]).toMatchObject({ kind: 'reconcile', reasonCode: 'reconciled', status: 'running' });
    await expect(reconcileIncompleteAttempt({
      state,
      expectedVersion: before.lastSeq,
      phase: 'scan',
      attempt: 1,
      reasonCode: 'provider-error',
    })).rejects.toThrow(/version 충돌/);
  });

  it('resumes awaiting input only with the expected revision and lineage', async () => {
    const { engagementDir, state } = createStore('resume-run');
    const initialContent = 'initial input';
    const initialPath = join(engagementDir, 'input-0.txt');
    const initialManifest = writeArtifact(engagementDir, 'input-0.txt', initialContent, 'input', '0');
    state.append({
      type: 'input.recorded',
      eventId: 'resume-run:input:0',
      input: {
        inputRevision: 0,
        contextEpoch: 'a'.repeat(64),
        manifest: initialManifest,
        allowedReadFiles: [initialPath],
        fileHashes: [fileHash(initialPath, initialContent)],
      },
    });
    const clarification = writeArtifact(engagementDir, 'clarification.json', '{}', 'analyze', 'analyze:-:1');
    state.append({
      type: 'run.awaiting-input',
      eventId: 'resume-run:awaiting',
      reason: 'missing evidence',
      artifact: clarification,
    });
    const revisedContent = 'revised input';
    const revisedPath = join(engagementDir, 'input-1.txt');
    const revisedManifest = writeArtifact(engagementDir, 'input-1.txt', revisedContent, 'input', '1');
    const telemetry = new InMemoryTelemetrySink();
    const resumed = await resumeRunWithInput({
      state,
      expectedVersion: state.read().lastSeq,
      revisedInput: {
        inputRevision: 1,
        contextEpoch: 'b'.repeat(64),
        manifest: revisedManifest,
        allowedReadFiles: [revisedPath],
        fileHashes: [fileHash(revisedPath, revisedContent)],
        parent: {
          manifestSha256: initialManifest.sha256,
          triggerArtifactSha256: clarification.sha256,
        },
      },
      telemetry,
    });
    expect(resumed.status).toBe('running');
    expect(resumed.inputManifest?.inputRevision).toBe(1);
    expect(telemetry.list()[0]).toMatchObject({ kind: 'resume', inputRevision: 1, contextEpoch: 'b'.repeat(64) });
    expect(JSON.stringify(telemetry.list())).not.toContain(revisedContent);
  });
});
