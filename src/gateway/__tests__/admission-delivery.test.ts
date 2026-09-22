import { afterEach, expect, it, vi } from 'vitest';
import { deliverAdmission, QueueDeliveryError } from '../job/admission.js';
import { enqueue, type RedisConnection } from '../job/queue.js';
import type { Job } from '../job/types.js';
vi.mock('../job/queue.js', () => ({ enqueue: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
it('returns a retryable job identity when queue delivery never settles', async () => {
  vi.useFakeTimers(); vi.mocked(enqueue).mockReturnValue(new Promise(() => {}));
  const pending = deliverAdmission({ kind: 'created', job: { id: 'persisted-job', status: 'queued' } as Job }, {} as RedisConnection);
  const result = expect(pending).rejects.toMatchObject({ name: 'Error', jobId: 'persisted-job' });
  await vi.advanceTimersByTimeAsync(5000); await result; expect(vi.getTimerCount()).toBe(0);
});
it.each(['running', 'waiting', 'completed', 'failed', 'cancelled'])('does not enqueue a duplicate %s job', async status => {
  await deliverAdmission({ kind: 'duplicate', job: { id: 'job', status } as Job }, {} as RedisConnection);
  expect(enqueue).not.toHaveBeenCalled();
});
it('preserves a committed job ID when enqueue rejects', async () => {
  vi.mocked(enqueue).mockRejectedValue(new Error('Redis failed'));
  await expect(deliverAdmission({ kind: 'created', job: { id: 'job', status: 'queued' } as Job }, {} as RedisConnection)).rejects.toBeInstanceOf(QueueDeliveryError);
});
