import { expect, it, vi } from 'vitest';
import { createSocAgent, SocLlmClient, type SocModel, type SocSignal } from '../../index.js';
const signalFor = (tenantId: string): SocSignal => ({ signalId: `signal-${tenantId}`, signalType: 'alert', source: 'application', severity: 'medium', timestamp: '2026-09-18T01:00:00Z', subject: { type: 'ip', value: '192.0.2.1' }, tenantId });
const assessment = (id: string) => ({ decision: 'monitor', threatLevel: 'inconclusive', confidence: 0.5, title: 'Follow-up required', summary: 'The event alone does not establish intent.', findings: [], affectedEntities: [], recommendation: { immediate: null, shortTerm: 'Review account context', monitoring: 'Operator follow-up' }, mitreTactics: [], evidenceIds: [id], unresolved: ['Intent is unknown'], stopReason: 'no-useful-next-action' });
it('uses application code adapters without an HTTP server, environment credentials or gateway', async () => {
  const calls: Array<{ tenant: string; tool: string; parameters: Record<string, unknown> }> = [];
  const llm: SocModel = { async completeTurn(input) {
    const initial = JSON.parse(input.messages[0]!.content as string).initialEvidence;
    expect(input.tools.map(t => t.name)).toEqual(['get_signal']);
    return { content: input.messages.length === 1
      ? [{ type: 'tool_use', id: 'read', name: 'get_signal', input: { signalId: initial.signal.signalId, reason: 'Read the triggering event to decide whether escalation is needed.', evidenceIds: [initial.evidenceId] } }]
      : [{ type: 'text', text: JSON.stringify(assessment('E1')) }], stopReason: input.messages.length === 1 ? 'tool_use' : 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const agent = createSocAgent({ llm, capabilities: ['get_signal'], dataSource: { createConnector(signal) {
    return { async execute(tool, parameters, abort) {
      expect(abort.aborted).toBe(false); calls.push({ tenant: signal.tenantId, tool, parameters });
      return { id: parameters.signalId, complete: true };
    } };
  } } });
  const results = await Promise.all(['a', 'b'].map(t => agent.run(signalFor(t))));
  expect(results.every(r => r.status === 'completed' && r.modelCalls === 2)).toBe(true);
  expect(calls).toEqual(['a', 'b'].map(tenant => ({ tenant, tool: 'get_signal', parameters: { signalId: `signal-${tenant}` } })));
});
it('accepts independently configured model clients without changing parent authentication', async () => {
  const before = process.env.ANTHROPIC_API_KEY;
  const headers: unknown[] = [];
  const results = await Promise.all(['a', 'b'].map(async tenant => {
    const llm = new SocLlmClient({ apiKey: `fixture-${tenant}`, fetchImpl: (async (_url, request) => {
      headers.push(request!.headers);
      return Response.json({ content: [{ type: 'text', text: JSON.stringify(assessment(`signal:signal-${tenant}`)) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    }) as typeof fetch });
    return createSocAgent({ llm, dataSource: { createConnector: () => ({ execute: vi.fn() }) } }).run(signalFor(tenant));
  }));
  expect(results.every(r => r.status === 'completed')).toBe(true);
  expect(headers).toEqual(expect.arrayContaining([expect.objectContaining({ 'x-api-key': 'fixture-a' }), expect.objectContaining({ 'x-api-key': 'fixture-b' })]));
  expect(process.env.ANTHROPIC_API_KEY).toBe(before);
});
it('passes application cancellation through the model call and preserves incomplete status', async () => {
  const controller = new AbortController();
  const agent = createSocAgent({ llm: { async completeTurn(input) {
    controller.abort(new Error('application cancelled')); expect(input.signal.aborted).toBe(true);
    return { content: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } };
  } }, dataSource: { createConnector: () => ({ execute: vi.fn() }) } });
  const result = await agent.run(signalFor('a'), { signal: controller.signal });
  expect(result.status).toBe('incomplete'); expect(result.reason).toContain('application cancelled');
});

it('allows a trusted domain guard to reject a contradiction within the single correction budget', async () => {
  const signal = signalFor('a');
  const llm = { completeTurn: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify(assessment(`signal:${signal.signalId}`)) }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }) };
  const guard = vi.fn(input => { input.assessment.decision = 'dismiss'; return 'Trusted incident state requires escalation'; });
  const agent = createSocAgent({ llm, dataSource: { createConnector: () => ({ execute: vi.fn() }) }, assessmentGuard: guard });
  const result = await agent.run(signal);
  expect(result.status).toBe('incomplete'); expect(result.result).toBeUndefined();
  expect(llm.completeTurn).toHaveBeenCalledTimes(2); expect(guard).toHaveBeenCalledTimes(2);
  expect(result.reason).toContain('Trusted incident');
});
it('counts cache reads and writes in total input and applies the token limit', async () => {
  const fetchImpl = vi.fn(async (_url, init) => {
    expect(JSON.parse(init.body).system[0].cache_control).toEqual({ type: 'ephemeral' });
    return Response.json({ content: [{ type: 'tool_use', id: 't1', name: 'get_signal', input: { signalId: 'signal-a', reason: 'Check observed event', evidenceIds: ['signal:signal-a'] } }], stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } });
  });
  const execute = vi.fn();
  const result = await createSocAgent({ llm: new SocLlmClient({ apiKey: 'fixture', fetchImpl: fetchImpl as typeof fetch }), dataSource: { createConnector: () => ({ execute }) }, limits: { maxTotalTokens: 1000 } }).run(signalFor('a'));
  expect(result.usage).toEqual({ inputTokens: 1210, outputTokens: 5, cacheReadTokens: 1000, cacheWriteTokens: 200 });
  expect(result.status).toBe('incomplete'); expect(execute).not.toHaveBeenCalled(); expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it('preserves prototype methods and private state in application data sources', async () => {
  const execute = vi.fn(async () => ({ complete: true }));
  class DataSource {
    #execute = execute;
    createConnector() { return { execute: this.#execute }; }
  }
  const llm: SocModel = { async completeTurn() {
    return { content: [{ type: 'text', text: JSON.stringify(assessment('signal:signal-a')) }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  expect((await createSocAgent({ llm, dataSource: new DataSource() }).run(signalFor('a'))).status).toBe('completed');
});
