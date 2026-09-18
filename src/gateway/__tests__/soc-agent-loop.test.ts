import { describe, expect, it, vi } from 'vitest';
import { investigate, type InvestigationTool } from '../adapters/soc/agent-loop.js';
import { validateAssessment } from '../adapters/soc/investigation-policy.js';

const usage = { inputTokens: 10, outputTokens: 5 };
const done = (value: unknown = { decision: 'stop' }) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], stopReason: 'end_turn', usage });
const call = (name = 'lookup', input: Record<string, unknown> = {}) => ({ content: [{ type: 'tool_use', id: 't1', name,
  input: { subject: 'observed-host', reason: 'Check whether the account is compromised', evidenceIds: ['signal:s1'], ...input } }], stopReason: 'tool_use', usage });
function setup(responses: Array<{ content: Array<Record<string, unknown>>; stopReason: string; usage: typeof usage }>, options: Record<string, unknown> = {}) {
  const execute = vi.fn().mockResolvedValue({ account: 'observed-account' });
  const tool: InvestigationTool = { name: 'lookup', description: 'Lookup', input_schema: { type: 'object' },
    parseInput: value => value as Record<string, unknown>, execute };
  const llm = { completeTurn: vi.fn() };
  for (const response of responses) llm.completeTurn.mockResolvedValueOnce(response);
  return { execute, llm, run: () => investigate({ llm, tools: [tool], initialEvidenceIds: ['signal:s1'], system: 'policy',
    prompt: 'signal', validateFinal: value => value, ...options }) };
}

describe('model-directed investigation', () => {
  it('lets observations determine subsequent targets and stops without a fixed checklist', async () => {
    const s = setup([call(), call('lookup', { subject: 'observed-account', evidenceIds: ['E1'] }), done()]);
    const run = await s.run();
    expect(run.status).toBe('completed');
    expect(s.execute).toHaveBeenCalledTimes(2);
    expect(s.execute.mock.calls[1]![0].subject).toBe('observed-account');
    const messages = s.llm.completeTurn.mock.calls[1]![0].messages;
    expect(JSON.stringify(messages)).toContain('observed-account');
    expect(run.observations.map(o => o.evidenceId)).toEqual(['E1', 'E2']);
  });
  it('accepts an immediate supported stop without using a tool', async () => {
    const s = setup([done()]);
    expect((await s.run()).status).toBe('completed');
    expect(s.execute).not.toHaveBeenCalled();
  });
  it('reuses identical lookups even when the rationale changes', async () => {
    const s = setup([call(), call('lookup', { reason: 'A differently phrased rationale', evidenceIds: ['E1'] }), done()]);
    const run = await s.run();
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(run.actions[1]?.cached).toBe(true);
  });
  it('stops offering tools after two turns without new evidence', async () => {
    const s = setup([call('missing'), call('missing'), done()]);
    const run = await s.run();
    expect(run.status).toBe('completed');
    expect(s.llm.completeTurn.mock.calls[2]![0].allowTools).toBe(false);
    expect(s.execute).not.toHaveBeenCalled();
  });
  it('does not act on an invented evidence reference', async () => {
    const s = setup([call('lookup', { evidenceIds: ['E999'] }), done()]);
    const run = await s.run();
    expect(s.execute).not.toHaveBeenCalled();
    expect(run.actions[0]?.error).toContain('existing evidence');
  });
  it('does not accept a dependency that the model has not yet observed in the same turn', async () => {
    const first = call();
    first.content.push({ ...call('lookup', { subject: 'new', evidenceIds: ['E1'] }).content[0]!, id: 't2' });
    const s = setup([first, done()]);
    expect((await s.run()).actions[1]?.error).toContain('existing evidence');
    expect(s.execute).toHaveBeenCalledTimes(1);
  });
  it('preserves unavailable evidence and does not retry the same failed query', async () => {
    const s = setup([call(), call(), done()]);
    s.execute.mockRejectedValue(new Error('unavailable'));
    const run = await s.run();
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(run.observations[0]?.ok).toBe(false);
    expect(run.observations[0]?.data).toMatchObject({ note: 'Unavailable evidence is not a negative finding.' });
  });
  it('marks truncated data rather than presenting it as complete', async () => {
    const s = setup([call(), done()]);
    s.execute.mockResolvedValue('x'.repeat(17000));
    expect((await s.run()).observations[0]?.truncated).toBe(true);
  });
  it.each([{ complete: false }, { hasMore: true }, { _meta: { truncated: true } }])('preserves backend-declared incomplete coverage %j', async (metadata) => {
    const s = setup([call(), done()]);
    const data = { events: [], ...metadata };
    s.execute.mockResolvedValue(data);
    const observation = (await s.run()).observations[0]!;
    expect(observation.truncated).toBe(true);
    expect(observation.data).toEqual(data);
    expect(() => validateAssessment({ ...assessment, decision: 'dismiss', threatLevel: 'benign', unresolved: [], evidenceIds: ['E1'] }, [observation], 'signal:s1')).toThrow('incomplete evidence');
  });
  it('caps actual tool calls even for multiple requests in one response', async () => {
    const response = call();
    response.content.push({ ...call('lookup', { subject: 'other' }).content[0]!, id: 't2' });
    const s = setup([response, done()], { maxToolCalls: 1 });
    await s.run();
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(s.llm.completeTurn.mock.calls[1]![0].allowTools).toBe(false);
  });
  it('does not start correction or investigation calls after the token budget is spent', async () => {
    const s = setup([done('invalid')], { maxTotalTokens: 10, validateFinal: () => { throw new Error('invalid final'); } });
    expect((await s.run()).reason).toContain('token limit');
    expect(s.llm.completeTurn).toHaveBeenCalledTimes(1);
  });
  it('allows only one final answer correction', async () => {
    const s = setup([done(), done()], { validateFinal: () => { throw new Error('bad evidence'); } });
    expect((await s.run()).status).toBe('incomplete');
    expect(s.llm.completeTurn).toHaveBeenCalledTimes(2);
  });
  it('does not execute tools or return a completed result after cancellation', async () => {
    const controller = new AbortController();
    const s = setup([call()], { signal: controller.signal });
    s.llm.completeTurn.mockReset().mockImplementationOnce(async () => { controller.abort(); return call(); });
    expect((await s.run()).status).toBe('incomplete');
    expect(s.execute).not.toHaveBeenCalled();
  });
});

export const assessment = { decision: 'monitor', threatLevel: 'inconclusive', confidence: 0.4, title: 'Review', summary: 'Need context',
  findings: [], affectedEntities: [], recommendation: { immediate: null, shortTerm: 'Review', monitoring: 'Advice' },
  mitreTactics: [], evidenceIds: ['signal:s1'], unresolved: ['Ownership unknown'], stopReason: 'no-useful-next-action' };
describe('grounded assessment', () => {
  it('allows a supported benign conclusion despite an unrelated optional lookup failure', () => {
    const benign = { ...assessment, decision: 'dismiss', threatLevel: 'benign', unresolved: [], evidenceIds: ['signal:s1', 'E1'] };
    const observations = [
      { evidenceId: 'E1', tool: 'get_rule', input: {}, ok: true, truncated: false, data: { authorizedExercise: true } },
      { evidenceId: 'E2', tool: 'get_threat_intel', input: {}, ok: false, truncated: false, data: { error: 'unavailable' } },
    ];
    expect(validateAssessment(benign, observations, 'signal:s1')).toMatchObject({ decision: 'dismiss' });
    expect(() => validateAssessment({ ...benign, evidenceIds: ['signal:s1'] }, observations, 'signal:s1')).toThrow('incomplete evidence');
  });

  it('allows uncertainty without mandatory extra queries', () => expect(validateAssessment(assessment, [], 'signal:s1')).toEqual(assessment));
  it('rejects benign conclusions without corroborating evidence', () => expect(() => validateAssessment({ ...assessment, decision: 'dismiss', threatLevel: 'benign', unresolved: [] }, [], 'signal:s1')).toThrow('incomplete evidence'));
  it('rejects fabricated evidence references', () => expect(() => validateAssessment({ ...assessment, evidenceIds: ['E999'] }, [], 'signal:s1')).toThrow('evidence reference'));
  it('does not turn API failure into benign', () => expect(() => validateAssessment({ ...assessment, decision: 'dismiss', threatLevel: 'benign', unresolved: [] }, [{ evidenceId: 'E1', tool: 'lookup', input: {}, ok: false, truncated: false, data: null }], 'signal:s1')).toThrow('incomplete evidence'));
});
