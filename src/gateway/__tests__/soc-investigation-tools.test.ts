import { describe, expect, it, vi } from 'vitest';
import { createInvestigationTools } from '../adapters/soc/investigation-tools.js';
import { SocLlmClient } from '../adapters/soc/llm-client.js';
import type { SocSignal } from '../adapters/soc/types.js';
const signal = { signalId: 's1', timestamp: '2026-09-01T01:00:00Z' } as SocSignal;
const why = { reason: 'Does this observed relationship change escalation?', evidenceIds: ['signal:s1'] };
function setup(response = Response.json({ items: [] })) {
  const fetchImpl = vi.fn().mockResolvedValue(response);
  const tools = createInvestigationTools({ signal, baseUrl: 'https://core.example', token: 'host-secret', fetchImpl });
  const invoke = (name: string, args: Record<string, unknown>) => {
    const tool = tools.find(tool => tool.name === name)!;
    return tool.execute(tool.parseInput({ ...args, ...why }), new AbortController().signal);
  };
  return { fetchImpl, tools, invoke };
}
describe('nunchi-core investigation tools', () => {
  it('uses the entity investigation endpoint and parameter names', async () => {
    const s = setup();
    await s.invoke('investigate_entity', { entityType: 'principal', entityValue: 'observed-user' });
    const [url, options] = s.fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://core.example/api/v1/investigate/entity?entity_type=principal&entity_value=observed-user&period=24h');
    expect(options.method).toBe('GET');
  });
  it('uses POST graph traversal with bounded relationship depth', async () => {
    const s = setup();
    await s.invoke('get_entity_graph', { entityType: 'ip', entityValue: '192.0.2.1' });
    const [url, options] = s.fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://core.example/api/v1/graph/traverse');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ entity_type: 'ip', entity_value: '192.0.2.1', max_hops: 1, max_nodes: 30 });
  });
  it('searches indicators using search, without treating a total as a match', async () => {
    const s = setup(Response.json({ total: 9, indicators: [] }));
    expect(await s.invoke('get_threat_intel', { indicator: '192.0.2.1' })).toMatchObject({ total: 9, indicators: [] });
    expect(s.fetchImpl.mock.calls[0]![0]).toContain('?search=192.0.2.1&limit=20');
  });
  it('sends NQL and a signal-relative bounded time window', async () => {
    const s = setup();
    await s.invoke('search_events', { query: 'source.ip = "192.0.2.1"' });
    const [url, options] = s.fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://core.example/api/v1/events/search/query');
    expect(JSON.parse(options.body)).toEqual({ query: { version: '1', text: 'source.ip = "192.0.2.1"' },
      time_from: '2026-09-01T00:30:00.000Z', time_to: '2026-09-01T01:00:00.000Z', page: 1, size: 20 });
    expect(JSON.stringify(s.tools)).not.toContain('host-secret');
  });
  it('rejects HTTP and application errors as unavailable evidence', async () => {
    await expect(setup(new Response('unavailable', { status: 503 })).invoke('get_signal', { signalId: 's1' })).rejects.toThrow('503');
    await expect(setup(Response.json({ error: 'backend failed' })).invoke('get_signal', { signalId: 's1' })).rejects.toThrow('unavailable evidence');
  });
  it('rejects broad actions and missing rationale before API execution', () => {
    const s = setup();
    const tool = s.tools.find(tool => tool.name === 'get_entity_graph')!;
    expect(() => tool.parseInput({ ...why, entityType: 'ip', entityValue: '192.0.2.1', maxHops: 100 })).toThrow();
    expect(() => tool.parseInput({ entityType: 'ip', entityValue: '192.0.2.1' })).toThrow();
    expect(s.fetchImpl).not.toHaveBeenCalled();
  });
});
describe('native model tool protocol', () => {
  it('retains tool definitions for historical tool messages while disabling new calls', async () => {
    const content = [{ type: 'text', text: '{}' }];
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ content, stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 10 } }));
    const client = new SocLlmClient({ apiKey: 'test', fetchImpl });
    const tool = { name: 'lookup', description: 'Lookup', input_schema: { type: 'object', properties: {} } };
    const messages = [{ role: 'assistant' as const, content: [{ type: 'tool_use', name: 'lookup', id: 't1', input: {} }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'evidence' }] }];
    expect(await client.completeTurn({ system: 'policy', messages, tools: [tool], allowTools: false, signal: new AbortController().signal })).toMatchObject({ content, stopReason: 'end_turn' });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toMatchObject({ messages, tools: [tool], tool_choice: { type: 'none' } });
  });
});
