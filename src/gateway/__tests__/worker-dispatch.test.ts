import { beforeEach, expect, it, vi } from 'vitest';
import { createDomainWorker } from '../workers/runner.js';
import { getJob } from '../job/store.js';
import { transitionJob } from '../job/lifecycle.js';
import type { PgPool } from '../job/store.js';
import type { Job } from '../job/types.js';
import type { Redis } from 'ioredis';
const capture = vi.hoisted(() => ({ process: undefined as undefined | ((job: unknown) => Promise<void>) }));
vi.mock('bullmq', () => ({ Worker: class {
  constructor(_name: string, processor: typeof capture.process) { capture.process = processor; }
  on() {}
} }));
vi.mock('../job/store.js', () => ({ getJob: vi.fn() }));
vi.mock('../job/lifecycle.js', async importOriginal => ({ ...await importOriginal<typeof import('../job/lifecycle.js')>(), transitionJob: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it.each(['cancelled', 'completed', 'rejected', 'waiting'] as const)('does not execute a stale delivery for %s jobs', async status => {
  vi.mocked(getJob).mockResolvedValue({ id: 'job', status, pendingInput: { requestId: 'unanswered' } } as unknown as Job);
  const handler = { domain: 'soc' as const, process: vi.fn(), resume: vi.fn() };
  createDomainWorker(handler, {} as Redis, {} as PgPool);
  await capture.process!({ data: { jobId: 'job' } });
  expect(handler.process).not.toHaveBeenCalled(); expect(handler.resume).not.toHaveBeenCalled();
  expect(transitionJob).not.toHaveBeenCalled();
});
it('re-enters running through the allowed retry states before calling the handler', async () => {
  vi.mocked(getJob).mockResolvedValue({ id: 'job', status: 'failed', pendingInput: null } as unknown as Job);
  const handler = { domain: 'soc' as const, process: vi.fn(async (job: Job) => { expect(job.status).toBe('running'); }) };
  createDomainWorker(handler, {} as Redis, {} as PgPool);
  await capture.process!({ data: { jobId: 'job' }, attemptsMade: 1 });
  expect(vi.mocked(transitionJob).mock.calls.map(call => call[2])).toEqual(['queued', 'running']);
  expect(handler.process).toHaveBeenCalledOnce();
});
