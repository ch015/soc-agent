import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/claude-agent-sdk', async (importOriginal) => ({
  ...(await importOriginal()),
  query: queryMock,
}));

import { runSession, type LedgerRow, type SessionSpec } from '../session.js';

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  const target = mkdtempSync(join(tmpdir(), 'nunchi-session-stream-'));
  return {
    domain: 'soc',
    mission: 'report',
    phase: 'evidence-review',
    allowedReadFiles: [join(target, 'snapshot.json')],
    target,
    prompt: 'host prompt with user-secret-source-content',
    engagementDir: join(target, 'reports', 'run'),
    engagementId: 'run',
    ...overrides,
  };
}

describe('runSession compact boundary transport', () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it('emits typed compact metadata without persisting summary or source text', async () => {
    queryMock.mockImplementation(() => {
      const stream = (async function* () {
        yield { type: 'system', subtype: 'init' };
        yield {
          type: 'system',
          subtype: 'compact_boundary',
          uuid: 'boundary-stream-1',
          session_id: 'session-1',
          compact_metadata: {
            trigger: 'auto',
            pre_tokens: 2400,
            post_tokens: 640,
            duration_ms: 22,
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: '{"status":"complete"}',
          structured_output: { status: 'complete' },
          num_turns: 2,
          total_cost_usd: 0.1,
          modelUsage: {},
        };
      })();
      return Object.assign(stream, { supportedAgents: async () => [] });
    });

    const rows: LedgerRow[] = [];
    await runSession(spec({ onLedger: (row) => rows.push(row) }));

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        event: 'compact_boundary',
        compaction: {
          trigger: 'auto',
          preTokens: 2400,
          postTokens: 640,
          durationMs: 22,
          boundaryId: 'boundary-stream-1',
        },
      }),
    ]));
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('compact_summary');
    expect(serialized).not.toContain('summary produced from user-secret-source-content');
    expect(serialized).not.toContain('user-secret-source-content');
  });
});
