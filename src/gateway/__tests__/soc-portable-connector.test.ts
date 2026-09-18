import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInvestigationTools } from '../adapters/soc/investigation-tools.js';
import { investigateSignal } from '../../runtime/missions/investigate-signal.js';
import type { SocSignal } from '../adapters/soc/types.js';
const signal: SocSignal = { signalId: 's-portable', signalType: 'alert', source: 'other-siem', severity: 'medium', timestamp: '2026-09-18T01:00:00Z', subject: { type: 'ip', value: '192.0.2.1' }, tenantId: 'project-a' };
const rationale = { reason: 'Check the source event before deciding whether to escalate.', evidenceIds: ['signal:s-portable'] };
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } });
async function fixture() {
  const requests: Array<{ path: string; auth: string | undefined; body: any }> = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url!, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ events: [{ id: 'event-1', action: 'denied' }], complete: true }));
  });
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { requests, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/adapter` };
}
describe('portable SOC connector', () => {
  it('runs the real investigation loop against a different HTTP backend, preserving bounded autonomous tool selection', async () => {
    const f = await fixture();
    const assessment = { decision: 'monitor', threatLevel: 'inconclusive', confidence: 0.5, title: 'Denied event', summary: 'One denied event; user intent is unknown.', findings: [{ type: 'observation', description: 'The event was denied.', evidence: ['E1'], confidence: 1 }], affectedEntities: [], recommendation: { immediate: null, shortTerm: 'Review the account context.', monitoring: 'Operator follow-up is recommended.' }, mitreTactics: [], evidenceIds: ['E1'], unresolved: ['Account context is unavailable.'], stopReason: 'no-useful-next-action' };
    const llm = { completeTurn: vi.fn()
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'call-1', name: 'get_signal', input: { signalId: signal.signalId, ...rationale } }], stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 10 } })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: JSON.stringify(assessment) }], stopReason: 'end_turn', usage: { inputTokens: 20, outputTokens: 10 } }) };
    const run = await investigateSignal({ signal, baseUrl: f.url, token: 'adapter-secret', connector: 'http-json', capabilities: ['get_signal'], context: 'Project A' }, { llm });
    expect(run.status).toBe('completed'); expect(run.actions).toHaveLength(1); expect(run.modelCalls).toBe(2);
    expect(f.requests).toEqual([{ path: '/adapter/tools/get_signal', auth: 'Bearer adapter-secret', body: { version: '1', parameters: { signalId: 's-portable' }, context: { signalId: 's-portable', tenantId: 'project-a', timestamp: signal.timestamp } } }]);
    expect(llm.completeTurn.mock.calls[0]![0].tools.map((t: any) => t.name)).toEqual(['get_signal']);
    expect(JSON.stringify(llm.completeTurn.mock.calls)).not.toContain('adapter-secret');
  });
  it('treats HTTP failure, application failure and invalid response as unavailable evidence', async () => {
    for (const response of [new Response('failure', { status: 503 }), Response.json({ error: 'internal-secret' }), Response.json(null)]) {
      const fetchImpl = vi.fn().mockResolvedValue(response);
      const tool = createInvestigationTools({ signal, connector: 'http-json', baseUrl: 'https://adapter.example', token: 'secret', fetchImpl, capabilities: ['get_signal'] })[0]!;
      await expect(tool.execute({ signalId: signal.signalId, ...rationale }, new AbortController().signal)).rejects.toThrow(/503|unavailable evidence|invalid connector response/);
      expect(fetchImpl.mock.calls[0]![1].redirect).toBe('error');
    }
  });
  it('rejects invalid capabilities and embedded URL credentials', () => {
    expect(() => createInvestigationTools({ signal, baseUrl: 'https://adapter.example', token: '', capabilities: ['typo'] })).toThrow('unknown investigation capability');
    expect(() => createInvestigationTools({ signal, connector: 'http-json', baseUrl: 'https://user:secret@adapter.example', token: '' })).toThrow('URL');
  });
  it('bounds connector response size', async () => {
    const tool = createInvestigationTools({ signal, connector: 'http-json', baseUrl: 'https://adapter.example', token: '', capabilities: ['get_signal'], fetchImpl: vi.fn().mockResolvedValue(Response.json({ data: 'x'.repeat(1000001) })) })[0]!;
    await expect(tool.execute({ signalId: signal.signalId, ...rationale }, new AbortController().signal)).rejects.toThrow('too large');
  });
  it('does not turn an unavailable model into a completed report', async () => {
    const run = await investigateSignal({ signal, baseUrl: 'https://adapter.example', token: '', capabilities: ['get_signal'] }, { llm: { completeTurn: vi.fn().mockRejectedValue(new Error('model unavailable')) } });
    expect(run.status).toBe('incomplete'); expect(run.result).toBeUndefined(); expect(run.actions).toEqual([]);
  });
});
