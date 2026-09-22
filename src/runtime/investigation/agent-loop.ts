import type { SocLlmClient, Message, ToolDefinition } from './llm-client.js';

export interface InvestigationTool extends ToolDefinition {
  parseInput(value: unknown): Record<string, unknown>;
  execute(input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
export interface Observation {
  evidenceId: string;
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  data: unknown;
  truncated: boolean;
}
export interface InvestigationRun<T> {
  status: 'completed' | 'incomplete';
  result?: T;
  reason?: string;
  observations: Observation[];
  actions: Array<{ tool: string; reason: string; evidenceId?: string; cached?: boolean; error?: string }>;
  modelCalls: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
}

/** The model owns investigation order; the host executes and bounds actions. */
export async function investigate<T>(input: {
  llm: Pick<SocLlmClient, 'completeTurn'>;
  system: string;
  prompt: string;
  initialEvidenceIds: string[];
  tools: InvestigationTool[];
  validateFinal(value: unknown, observations: Observation[]): T;
  signal?: AbortSignal;
  maxTurns?: number;
  maxToolCalls?: number;
  timeoutMs?: number;
  maxTotalTokens?: number;
  maxConcurrentTools?: number;
  beforeTurn?: () => Promise<void>;
}): Promise<InvestigationRun<T>> {
  const run: InvestigationRun<T> = {
    status: 'incomplete', observations: [], actions: [], modelCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const maxTurns = bounded(input.maxTurns, 8, 1, 16);
  const maxTools = bounded(input.maxToolCalls, 12, 1, 32);
  const concurrency = bounded(input.maxConcurrentTools, 2, 1, 4);
  const tokenLimit = bounded(input.maxTotalTokens, 60_000, 1, 200_000);
  const timeoutMs = bounded(input.timeoutMs, 120_000, 1, 300_000);
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error('investigation deadline exceeded')), timeoutMs);
  const messages: Message[] = [{ role: 'user', content: input.prompt }];
  const tools = new Map(input.tools.map(tool => [tool.name, tool]));
  const evidence = new Set(input.initialEvidenceIds);
  const cache = new Map<string, Observation>();
  let requestedTools = 0;
  let noProgress = 0;
  let finalCorrections = 0;
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      signal.throwIfAborted();
      if (run.usage.inputTokens + run.usage.outputTokens >= tokenLimit) throw new Error('investigation token limit reached');
      if (input.beforeTurn) await abortable(input.beforeTurn, signal);
      signal.throwIfAborted();
      const finishOnly = requestedTools >= maxTools || noProgress >= 2 || turn === maxTurns - 1;
      if (finishOnly) messages.push({ role: 'user', content:
        'Investigation limit reached. Make no more tool calls. Return the supported final assessment now; preserve missing evidence as inconclusive.' });
      const response = await abortable(() => input.llm.completeTurn({
        system: input.system, messages,
        allowTools: !finishOnly,
        tools: input.tools.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
        signal,
      }), signal);
      run.modelCalls++;
      const usage = response?.usage;
      if (!usage || [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0]
        .some(value => !Number.isSafeInteger(value) || value < 0)
        || !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)) throw new Error('invalid model usage receipt');
      run.usage.inputTokens += response.usage.inputTokens;
      run.usage.outputTokens += response.usage.outputTokens;
      for (const key of ['cacheReadTokens', 'cacheWriteTokens'] as const) {
        if (response.usage[key] !== undefined) run.usage[key] = (run.usage[key] ?? 0) + response.usage[key]!;
      }
      signal.throwIfAborted();
      const calls = response.content.filter(block => block.type === 'tool_use');
      if (calls.some(call => typeof call.id !== 'string' || !call.id.trim())
        || new Set(calls.map(call => call.id)).size !== calls.length) throw new Error('invalid model tool IDs');
      if (calls.length === 0) {
        if (response.stopReason !== 'end_turn') throw new Error(`model stopped without a complete answer: ${response.stopReason}`);
        const text = response.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('');
        try {
          const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
          run.result = input.validateFinal(JSON.parse(fenced ?? text), run.observations);
          run.status = 'completed';
          return run;
        } catch (error) {
          if (finalCorrections++ >= 1 || finishOnly) throw error;
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: `The final assessment could not be accepted: ${safeError(error)}. Correct it using available evidence; do not repeat completed investigation.` });
          continue;
        }
      }
      if (response.stopReason !== 'tool_use') throw new Error('incomplete tool request');
      messages.push({ role: 'assistant', content: response.content });
      const results: Array<Record<string, unknown>> = new Array(calls.length);
      const observedBeforeTurn = new Set(evidence);
      const jobs: Array<{ tool: InvestigationTool; args: Record<string, unknown>; observation: Observation; index: number }> = [];
      const reused: Array<{ observation: Observation; index: number }> = [];
      let newEvidence = false;
      // Reserve IDs and request budget in model order before any asynchronous work.
      for (const [index, call] of calls.entries()) {
        signal.throwIfAborted();
        const name = String(call.name ?? '');
        let reason = '';
        try {
          if (run.usage.inputTokens + run.usage.outputTokens >= tokenLimit) throw new Error('investigation token limit reached');
          if (finishOnly || requestedTools++ >= maxTools) throw new Error('tool call limit reached; finish with existing evidence');
          const tool = tools.get(name);
          if (!tool) throw new Error('unknown investigation tool');
          const args = tool.parseInput(call.input);
          reason = String(args.reason ?? '');
          const basedOn = args.evidenceIds as string[];
          if (!reason.trim() || !Array.isArray(basedOn) || !basedOn.length || basedOn.some(ref => !observedBeforeTurn.has(ref))) {
            throw new Error('each action needs an unresolved question and existing evidence IDs');
          }
          const { reason: _reason, evidenceIds: _refs, ...request } = args;
          const key = `${name}:${canonical(request)}`;
          const cached = cache.get(key);
          if (cached) {
            run.actions.push({ tool: name, reason, evidenceId: cached.evidenceId, cached: true });
            reused.push({ observation: cached, index });
            continue;
          }
          const observation: Observation = {
            evidenceId: `E${run.observations.length + 1}`, tool: name, input: request,
            ok: false, data: { note: 'Investigation did not finish this lookup.' }, truncated: false,
          };
          run.observations.push(observation);
          cache.set(key, observation);
          run.actions.push({ tool: name, reason, evidenceId: observation.evidenceId });
          jobs.push({ tool, args, observation, index });
        } catch (error) {
          signal.throwIfAborted();
          const message = safeError(error);
          run.actions.push({ tool: name, reason, error: message });
          results[index] = { type: 'tool_result', tool_use_id: call.id, is_error: true, content: message };
        }
      }
      let nextJob = 0;
      const workers = await Promise.allSettled(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
        while (nextJob < jobs.length) {
          signal.throwIfAborted();
          const { tool, args, observation, index } = jobs[nextJob++]!;
          try {
            const data = await abortable(() => tool.execute(args, signal), signal);
            signal.throwIfAborted();
            const serialized = JSON.stringify(data);
            if (serialized === undefined) throw new Error('tool returned no evidence');
            const oversized = serialized.length > 16_000;
            const coverage = data && typeof data === 'object' ? data as Record<string, unknown> : {};
            const metadata = coverage._meta && typeof coverage._meta === 'object' ? coverage._meta as Record<string, unknown> : {};
            observation.truncated = oversized || coverage.complete === false || coverage.hasMore === true
              || coverage.truncated === true || metadata.complete === false || metadata.hasMore === true || metadata.truncated === true;
            observation.data = oversized
              ? { excerpt: serialized.slice(0, 16_000), note: 'Partial response. Narrow the query if omitted evidence could change the decision.' }
              : data;
            observation.ok = true;
            newEvidence = true;
          } catch (error) {
            observation.ok = false;
            observation.data = { error: safeError(error), note: 'Unavailable evidence is not a negative finding.' };
            signal.throwIfAborted();
          }
          evidence.add(observation.evidenceId);
          results[index] = { type: 'tool_result', tool_use_id: calls[index]!.id, is_error: !observation.ok, content: JSON.stringify(observation) };
        }
      }));
      const failed = workers.find(worker => worker.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      signal.throwIfAborted();
      for (const { observation, index } of reused) {
        results[index] = { type: 'tool_result', tool_use_id: calls[index]!.id, is_error: !observation.ok,
          content: JSON.stringify({ evidenceId: observation.evidenceId, cached: true, ok: observation.ok,
            truncated: observation.truncated, note: 'Reuse the original observation already in this conversation; no lookup was repeated.' }) };
      }
      messages.push({ role: 'user', content: results });
      noProgress = newEvidence ? 0 : noProgress + 1;
      if (run.usage.inputTokens + run.usage.outputTokens >= tokenLimit) throw new Error('investigation token limit reached');
    }
    throw new Error('investigation turn limit reached');
  } catch (error) {
    run.reason = safeError(error);
    return run;
  } finally { clearTimeout(timer); }
}

/** Stop waiting even when an application adapter does not honor AbortSignal. */
function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancel));
  });
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error('invalid investigation limit');
  return value;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
