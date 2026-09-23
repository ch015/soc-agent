import { AsyncLocalStorage } from 'node:async_hooks';

export type JobExecution = { jobId: string; token: string; signal: AbortSignal };
const execution = new AsyncLocalStorage<JobExecution>();
export function withJobExecution<T>(value: JobExecution, operation: () => Promise<T>): Promise<T> {
  return execution.run(value, operation);
}
export function currentJobExecution(jobId?: string): JobExecution | undefined {
  const value = execution.getStore();
  if (value && jobId && value.jobId !== jobId) throw new Error('Execution job identity mismatch');
  value?.signal.throwIfAborted();
  return value;
}

/** Stop waiting at the boundary; late writes remain fenced by the execution token. */
export function untilAborted<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason); };
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); })
      .then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
