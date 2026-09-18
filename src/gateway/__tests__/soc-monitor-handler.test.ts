import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SocMonitorHandler } from '../workers/soc-monitor-handler.js';
import { SocLlmClient } from '../adapters/soc/llm-client.js';
import { getJob } from '../job/store.js';
import { transitionJob } from '../job/lifecycle.js';
import { resultRouter } from '../result/router.js';
import type { Job } from '../job/types.js';
import type { PgPool } from '../job/store.js';

vi.mock('../job/lifecycle.js', () => ({ emitProgress: vi.fn(), transitionJob: vi.fn() }));
vi.mock('../job/store.js', () => ({ getJob: vi.fn() }));
vi.mock('../result/router.js', () => ({ resultRouter: { route: vi.fn() } }));
const signal = { signalId: 's1', signalType: 'alert', source: 'test', severity: 'low', timestamp: '2026-09-01T00:00:00Z', subject: { type: 'ip', value: '192.0.2.1' }, tenantId: 'test' };
const job = { id: 'j1', status: 'running', input: { instruction: '', options: { signal } }, callback: { type: 'webhook' } } as unknown as Job;
const pool = {} as PgPool;
const assessment = { decision: 'monitor', threatLevel: 'inconclusive', confidence: 0.4, title: 'Review', summary: 'Need context',
  findings: [], affectedEntities: [], recommendation: { immediate: null, shortTerm: 'Review', monitoring: 'Advice' },
  mitreTactics: [], evidenceIds: ['signal:s1'], unresolved: ['Ownership unknown'], stopReason: 'no-useful-next-action' };
const llm = (overrides = {}) => ({ completeTurn: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ ...assessment, ...overrides }) }], stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 10 } }) });
const result = () => vi.mocked(transitionJob).mock.calls.at(-1)?.[3]?.result;
beforeEach(() => { vi.clearAllMocks(); vi.mocked(getJob).mockResolvedValue(job); });
afterEach(() => vi.unstubAllGlobals());

describe('SOC monitor autonomous investigation', () => {
  it('lets the model assess low severity and records monitor as advice', async () => {
    const model = llm();
    await new SocMonitorHandler({ llm: model, slackBotToken: '', toolFactory: () => [] }).process(job, pool);
    expect(model.completeTurn).toHaveBeenCalledOnce();
    expect(result()).toMatchObject({ decision: 'monitor', investigationStatus: 'completed', monitoringScheduled: false, notified: false });
  });
  it('reports missing model configuration as incomplete, never a heuristic dismissal', async () => {
    await new SocMonitorHandler({ llm: new SocLlmClient({ apiKey: '' }), slackBotToken: '', toolFactory: () => [] }).process(job, pool);
    expect(result()).toMatchObject({ decision: 'escalate', threatLevel: 'inconclusive', investigationStatus: 'incomplete', llmUsed: false, notified: false });
  });
  it('does not claim a notification without a configured token', async () => {
    await new SocMonitorHandler({ llm: llm({ decision: 'escalate' }), slackBotToken: '', toolFactory: () => [] }).process(job, pool);
    expect(result()).toMatchObject({ notified: false, reason: 'not-configured' });
  });
  it.each([false, true])('records the actual Slack receipt ok=%s', async ok => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok, ts: '123', error: ok ? undefined : 'channel_not_found' }));
    vi.stubGlobal('fetch', fetchMock);
    await new SocMonitorHandler({ llm: llm({ decision: 'escalate' }), slackBotToken: 'test-token', toolFactory: () => [] }).process(job, pool);
    expect(result()).toMatchObject({ notified: ok });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('stops a cancelled job without calling the model or routing a result', async () => {
    vi.mocked(getJob).mockResolvedValue({ ...job, status: 'cancelled' });
    const model = llm();
    await expect(new SocMonitorHandler({ llm: model, toolFactory: () => [] }).process(job, pool)).rejects.toThrow();
    expect(model.completeTurn).not.toHaveBeenCalled();
    expect(transitionJob).not.toHaveBeenCalled();
    expect(resultRouter.route).not.toHaveBeenCalled();
  });
});
