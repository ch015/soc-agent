import assert from 'node:assert/strict';
import { createSocAgent } from 'secops-soc-agent';
const signal = { signalId: 'probe', signalType: 'alert', source: 'fixture', severity: 'high', timestamp: '2026-09-21T00:00:00Z', subject: { type: 'ip', value: '192.0.2.25' }, tenantId: 'test' };
const cases = [];
for (const mode of ['app-entity-graph', 'native-entity-graph', 'duplicate', 'partial-benign']) {
  let calls = 0, executions = 0;
  const paths = [], toolsSeen = new Set();
  const data = { complete: mode !== 'partial-benign', observedEntity: '192.0.2.25', eventIds: ['event-1'], related: ['host-1'] };
  const llm = { async completeTurn(input) {
    calls++;
    for (const tool of input.tools) toolsSeen.add(tool.name);
    if (calls === 1 || (calls === 2 && mode !== 'partial-benign')) {
      const graph = calls === 2 && mode !== 'duplicate';
      return { content: [{ type: 'tool_use', id: 'tool-' + calls, name: graph ? 'get_entity_graph' : 'investigate_entity', input: {
        entityType: 'ip', entityValue: '192.0.2.25', reason: graph ? 'Resolve the observed relationship before a conclusion.' : 'Resolve related events for the observed IP.',
        evidenceIds: calls === 1 ? ['signal:probe'] : ['E1'], ...(graph ? { maxHops: 1, maxNodes: 10 } : { period: '24h' }) } }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } };
    }
    const partial = mode === 'partial-benign';
    const refs = mode === 'duplicate' || partial ? ['E1'] : ['E1','E2'];
    const result = { decision: partial ? 'dismiss' : 'escalate', threatLevel: partial ? 'benign' : 'suspicious', confidence: 0.7, title: 'Fixture assessment', summary: 'Fixture only; no model quality claim.',
      findings: partial ? [] : [{ type: 'observation', description: 'Observed event merits review.', evidence: refs, confidence: 0.7 }], affectedEntities: [],
      recommendation: { immediate: null, shortTerm: 'Review', monitoring: 'None' }, mitreTactics: [], evidenceIds: refs, unresolved: [], stopReason: 'sufficient-evidence' };
    return { content: [{ type: 'text', text: JSON.stringify(result) }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } };
  } };
  const dataSource = mode === 'native-entity-graph'
    ? { kind: 'nunchi-core', baseUrl: 'https://nunchi.invalid', token: 'fixture-token', fetchImpl: async (url, options) => {
      executions++; paths.push(new URL(url).pathname);
      if (new URL(url).pathname === '/api/v1/graph/traverse') assert.equal(options.method, 'POST');
      return new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } }
    : { createConnector: () => ({ execute: async () => { executions++; return data; } }) };
  const result = await createSocAgent({ llm, dataSource }).run(signal);
  assert.equal(toolsSeen.size, 8);
  assert.equal(result.status, mode === 'partial-benign' ? 'incomplete' : 'completed');
  if (mode === 'duplicate') { assert.equal(executions, 1); assert.equal(result.actions[1].cached, true); }
  if (mode.endsWith('entity-graph')) assert.equal(executions, 2);
  if (mode === 'native-entity-graph') assert.deepEqual(paths, ['/api/v1/investigate/entity', '/api/v1/graph/traverse']);
  cases.push({ mode, status: result.status, modelCalls: calls, connectorCalls: executions, toolsAvailable: toolsSeen.size, paths });
}
console.log(JSON.stringify(cases));
