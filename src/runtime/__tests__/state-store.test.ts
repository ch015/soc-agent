import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FileRunStateStore,
  RUN_STATE_FILE,
  type NewRunEvent,
  type RunStateStore,
} from '../workflow/state-store.js';
import { createArtifactRef } from '../contracts/result-contract.js';

function createStore() {
  const engagementDir = mkdtempSync(join(tmpdir(), 'nunchi-state-'));
  return FileRunStateStore.create({
    engagementDir,
    runId: 'run-1',
    contractId: 'nunchi.offsec.assessment',
    contractVersion: '1.0.0',
    domain: 'offsec',
    mission: 'assessment',
    maxBudgetUsd: 30,
  });
}

function append(store: RunStateStore, event: NewRunEvent): void {
  store.append(event);
}

describe('FileRunStateStore', () => {
  it('replays the event ledger and repairs a missing snapshot', () => {
    const store = createStore();
    append(store, { type: 'phase.started', eventId: 'va:start', phase: 'va', attempt: 1 });
    append(store, {
      type: 'attempt.received',
      eventId: 'va:receipt',
      phase: 'va',
      attempt: 1,
      usage: { provider: 'anthropic', costUsd: 1.25 },
    });
    append(store, {
      type: 'phase.completed',
      eventId: 'va:complete',
      phase: 'va',
      attempt: 1,
      artifacts: [],
      result: { status: 'complete' },
    });
    unlinkSync(join(store.engagementDir, RUN_STATE_FILE));

    const recovered = FileRunStateStore.open(store.engagementDir).read();
    expect(recovered.totalCostUsd).toBe(1.25);
    expect(recovered.completedPhases).toEqual(['va']);
    expect(recovered.attempts['va:-:1']?.status).toBe('completed');
    expect(readFileSync(join(store.engagementDir, RUN_STATE_FILE), 'utf8')).toContain('"lastSeq": 4');
  });

  it('charges a provider receipt once even if validation fails and the receipt is retried', () => {
    const store = createStore();
    append(store, { type: 'phase.started', eventId: 'va:start', phase: 'va', attempt: 1 });
    const receipt: NewRunEvent = {
      type: 'attempt.received',
      eventId: 'va:receipt',
      phase: 'va',
      attempt: 1,
      usage: { provider: 'anthropic', costUsd: 2.5 },
    };
    append(store, receipt);
    append(store, receipt);
    expect(() =>
      append(store, {
        ...receipt,
        usage: { provider: 'anthropic', costUsd: 99 },
      }),
    ).toThrow(/idempotency key 충돌/);
    append(store, {
      type: 'phase.failed',
      eventId: 'va:failed',
      phase: 'va',
      attempt: 1,
      reason: 'invalid structured output',
    });
    expect(store.read().totalCostUsd).toBe(2.5);
    expect(store.read().attempts['va:-:1']?.status).toBe('failed');
  });

  it('replays compact and identity audit events without changing the run snapshot', () => {
    const store = createStore();
    append(store, { type: 'phase.started', eventId: 'va:start', phase: 'va', attempt: 1 });
    const beforeCompaction = store.read();
    const compacted: NewRunEvent = {
      type: 'phase.context-compacted',
      eventId: 'va:compact:boundary-1',
      phase: 'va',
      attempt: 1,
      provider: 'anthropic-agent-sdk',
      trigger: 'auto',
      preTokens: 1000,
      postTokens: 250,
      durationMs: 42,
      boundaryId: 'boundary-1',
    };
    append(store, compacted);
    append(store, compacted);
    expect(store.read()).toMatchObject({
      status: beforeCompaction.status,
      totalCostUsd: beforeCompaction.totalCostUsd,
      completedPhases: beforeCompaction.completedPhases,
      attempts: { 'va:-:1': { status: 'started' } },
    });
    append(store, {
      type: 'attempt.received',
      eventId: 'va:receipt',
      phase: 'va',
      attempt: 1,
      usage: { provider: 'anthropic-agent-sdk', costUsd: 0.25 },
    });
    append(store, {
      type: 'phase.result-identity-bound',
      eventId: 'va:identity-bound',
      phase: 'va',
      attempt: 1,
      source: 'host',
      providerIdentity: 'overridden',
      provider: 'anthropic-agent-sdk',
    });
    const replayed = FileRunStateStore.open(store.engagementDir).read();
    expect(replayed).toMatchObject({
      status: 'running',
      totalCostUsd: 0.25,
      completedPhases: [],
      attempts: { 'va:-:1': { status: 'received' } },
    });
    const events = readFileSync(join(store.engagementDir, 'run-events.jsonl'), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toEqual([
      'run.created', 'phase.started', 'phase.context-compacted',
      'attempt.received', 'phase.result-identity-bound',
    ]);
  });

  it('rejects duplicate phase completion and corrupt event sequences', () => {
    const store = createStore();
    append(store, { type: 'phase.started', eventId: 'va:start', phase: 'va', attempt: 1 });
    expect(() =>
      append(store, {
        type: 'phase.completed',
        eventId: 'va:premature',
        phase: 'va',
        attempt: 1,
        artifacts: [],
        result: {},
      }),
    ).toThrow(/receipt 없이/);
    append(store, {
      type: 'attempt.received',
      eventId: 'va:receipt',
      phase: 'va',
      attempt: 1,
      usage: { provider: 'anthropic', costUsd: 0 },
    });
    append(store, {
      type: 'phase.completed',
      eventId: 'va:complete',
      phase: 'va',
      attempt: 1,
      artifacts: [],
      result: {},
    });
    expect(() =>
      append(store, {
        type: 'phase.completed',
        eventId: 'va:complete-2',
        phase: 'va',
        attempt: 1,
        artifacts: [],
        result: {},
      }),
    ).toThrow(/종료된 phase attempt/);

    const ledger = join(store.engagementDir, 'run-events.jsonl');
    const lines = readFileSync(ledger, 'utf8').trimEnd().split('\n');
    const last = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
    writeFileSync(ledger, `${lines.join('\n')}\n${JSON.stringify({ ...last, eventId: 'bad', seq: 99 })}\n`);
    expect(() => FileRunStateStore.open(store.engagementDir)).toThrow(/seq 불연속/);
  });

  it('records host input provenance and an idempotent publication event', () => {
    const store = createStore();
    writeFileSync(join(store.engagementDir, '01_feedback_input_manifest.json'), '{}\n');
    writeFileSync(join(store.engagementDir, '06_feedback_final.md'), '# final\n');
    const manifest = createArtifactRef({
      engagementDir: store.engagementDir,
      name: '01_feedback_input_manifest.json',
      phase: 'input',
      role: 'host',
      attempt: '0',
    });
    store.append({
      type: 'input.recorded',
      eventId: 'input:recorded',
      input: {
        inputRevision: 0,
        contextEpoch: 'a'.repeat(64),
        manifest,
        allowedReadFiles: [manifest.path, join(store.engagementDir, 'design.md')],
        fileHashes: [{ path: manifest.path, sha256: manifest.sha256, bytes: manifest.bytes }],
      },
    });
    expect(store.read().inputManifest?.manifest.producer.role).toBe('host');
    expect(() => store.append({
      type: 'input.recorded',
      eventId: 'input:recorded-2',
      input: {
        inputRevision: 0,
        contextEpoch: 'a'.repeat(64),
        manifest,
        allowedReadFiles: [manifest.path],
        fileHashes: [{ path: manifest.path, sha256: manifest.sha256, bytes: manifest.bytes }],
      },
    })).toThrow(/중복/);
    const final = createArtifactRef({
      engagementDir: store.engagementDir,
      name: '06_feedback_final.md',
      phase: 'publication',
      role: 'host',
      attempt: '1',
    });
    store.append({
      type: 'publication.completed',
      eventId: 'publication:completed',
      artifact: final,
      sourceManifestSha256: 'a'.repeat(64),
    });
    store.append({ type: 'publication.completed', eventId: 'publication:completed', artifact: final, sourceManifestSha256: 'a'.repeat(64) });
    expect(store.read().publication?.artifact.name).toBe('06_feedback_final.md');
    store.append({ type: 'run.completed', eventId: 'run:completed' });
    expect(store.read().status).toBe('completed');
  });

  it('records a host-owned awaiting-input transition without treating it as publication', () => {
    const engagementDir = mkdtempSync(join(tmpdir(), 'nunchi-feedback-awaiting-input-'));
    const store = FileRunStateStore.create({
      engagementDir,
      runId: 'feedback-awaiting',
      contractId: 'nunchi.feedback.design-review',
      contractVersion: '1.0.0',
      domain: 'feedback',
      mission: 'design-review',
      maxBudgetUsd: 30,
    });
    writeFileSync(join(engagementDir, '03_feedback_clarification_requests.json'), '{}\n');
    const artifact = createArtifactRef({
      engagementDir,
      name: '03_feedback_clarification_requests.json',
      phase: 'analyze',
      role: 'host',
      attempt: 'analyze:-:1',
    });
    store.append({
      type: 'run.awaiting-input',
      eventId: 'feedback:awaiting-input',
      reason: 'design evidence is incomplete',
      artifact,
    });
    expect(store.read().status).toBe('awaiting-input');
    expect(store.read().awaitingInput?.artifact.name).toBe('03_feedback_clarification_requests.json');
    expect(() => store.append({ type: 'run.completed', eventId: 'feedback:completed' })).toThrow(/종료된 run/);
    expect(FileRunStateStore.open(engagementDir).read().status).toBe('awaiting-input');
  });

  it('revises input and resumes atomically with an optimistic version', () => {
    const engagementDir = mkdtempSync(join(tmpdir(), 'nunchi-feedback-resume-state-'));
    const store = FileRunStateStore.create({
      engagementDir,
      runId: 'feedback-resume',
      contractId: 'nunchi.feedback.design-review',
      contractVersion: '1.1.0',
      domain: 'feedback',
      mission: 'design-review',
    });
    const initialPath = join(engagementDir, '01_feedback_input_manifest.json');
    writeFileSync(initialPath, '{"revision":0}\n');
    const initial = createArtifactRef({ engagementDir, name: '01_feedback_input_manifest.json', phase: 'input', role: 'host', attempt: '0' });
    store.append({
      type: 'input.recorded',
      eventId: 'feedback-resume:input:0',
      input: {
        inputRevision: 0,
        contextEpoch: 'a'.repeat(64),
        manifest: initial,
        allowedReadFiles: [initialPath],
        fileHashes: [{ path: initialPath, sha256: initial.sha256, bytes: initial.bytes }],
      },
    });
    const clarificationPath = join(engagementDir, '03_feedback_clarification_requests.json');
    writeFileSync(clarificationPath, '{"requests":[]}\n');
    const clarification = createArtifactRef({ engagementDir, name: '03_feedback_clarification_requests.json', phase: 'analyze', role: 'host', attempt: 'analyze:-:1' });
    store.append({ type: 'run.awaiting-input', eventId: 'feedback-resume:waiting:0', reason: 'input required', artifact: clarification });
    const expectedVersion = store.read().lastSeq;
    writeFileSync(join(engagementDir, 'answer.txt'), 'gateway\n');
    const answerPath = join(engagementDir, 'answer.txt');
    const answerContent = readFileSync(answerPath);
    const revisedPath = join(engagementDir, '01_feedback_input_manifest.r0001.json');
    writeFileSync(revisedPath, '{"revision":1}\n');
    const revised = createArtifactRef({ engagementDir, name: '01_feedback_input_manifest.r0001.json', phase: 'input', role: 'host', attempt: '1' });
    store.appendBatch([{
      type: 'input.revised',
      eventId: 'feedback-resume:input:1',
      input: {
        inputRevision: 1,
        contextEpoch: 'b'.repeat(64),
        manifest: revised,
        allowedReadFiles: [revisedPath, answerPath],
        fileHashes: [{ path: answerPath, sha256: createHash('sha256').update(answerContent).digest('hex'), bytes: answerContent.byteLength }],
        parent: { manifestSha256: initial.sha256, triggerArtifactSha256: clarification.sha256 },
      },
    }, { type: 'run.resumed', eventId: 'feedback-resume:resumed:1' }], expectedVersion);
    expect(store.read()).toMatchObject({ status: 'running', inputManifest: { inputRevision: 1, contextEpoch: 'b'.repeat(64) } });
    expect(store.read().awaitingInput).toBeUndefined();
    expect(() => store.appendBatch([], expectedVersion)).toThrow(/version 충돌/);
    expect(readFileSync(initialPath, 'utf8')).toBe('{"revision":0}\n');
  });
});
