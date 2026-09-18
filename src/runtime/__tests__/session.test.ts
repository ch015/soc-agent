/**
 * 격리 불변식 회귀 테스트.
 *
 * buildOptions 를 순수 함수로 분리한 이유가 이것이다 — 격리 설정이 빠지면
 * 조용히 동작하기 때문에, 사람이 아니라 테스트가 지켜야 한다.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildOptions,
  domainAgentNames,
  domainPluginPath,
  DOMAINS,
  recoverStructuredOutput,
  type SessionSpec,
} from '../session.js';

describe('structured output recovery', () => {
  it('recovers only a complete final JSON value when the SDK omits structured_output', () => {
    expect(recoverStructuredOutput(['progress', '{"status":"complete","artifacts":[]}']))
      .toEqual({ status: 'complete', artifacts: [] });
    expect(recoverStructuredOutput(['```json\n{"status":"complete"}\n```']))
      .toEqual({ status: 'complete' });
  });

  it('does not extract JSON from narrative text or malformed output', () => {
    expect(recoverStructuredOutput(['done: {"status":"complete"}'])).toBeUndefined();
    expect(recoverStructuredOutput(['```json\n{"status":"complete"}\n``` trailing'])).toBeUndefined();
    expect(recoverStructuredOutput(['{"status":'])).toBeUndefined();
  });
});

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  const target = mkdtempSync(join(tmpdir(), 'nunchi-session-test-'));
  return {
    domain: 'soc',
    mission: 'report',
    phase: 'evidence-review',
    allowedReadFiles: [join(target, 'snapshot.json')],
    target,
    prompt: '테스트',
    engagementDir: join(target, 'reports', 'x'),
    engagementId: 'x',
    ...overrides,
  };
}

describe('buildOptions — 격리', () => {
  it('파일시스템 settings 를 로드하지 않는다', () => {
    expect(buildOptions(spec()).settingSources).toEqual([]);
  });

  it('선언되지 않은 MCP 서버를 무시한다', () => {
    expect(buildOptions(spec()).strictMcpConfig).toBe(true);
  });

  it('요청한 도메인 플러그인 하나만 로드한다', () => {
    const options = buildOptions(spec({ domain: 'soc' }));
    expect(options.plugins).toHaveLength(1);
    expect(options.plugins?.[0]).toMatchObject({ type: 'local' });
    expect(options.plugins?.[0]?.path).toContain(join('domains', 'soc'));
  });

  it('세션 cwd 를 engagement 디렉토리로 고정한다', () => {
    const s = spec();
    expect(buildOptions(s).cwd).toBe(s.engagementDir);
  });

  it('벤더 훅이 읽는 런타임 환경변수를 채운다', () => {
    const s = spec();
    const env = buildOptions(s).env ?? {};
    expect(env.PROJECT_DIR).toBe(s.target);
    expect(env.AGENT_ENGAGEMENT_DIR).toBe(s.engagementDir);
    expect(env.AGENT_ENGAGEMENT_ID).toBe(s.engagementId);
    // env 는 병합이 아니라 치환이므로 PATH 같은 상속 변수가 살아 있어야 한다
    expect(env.PATH).toBeDefined();
  });

  it('phase 역할의 가용 도구를 최상위 계약으로 좁힌다', () => {
    const options = buildOptions(spec());
    expect(options.agent).toBeUndefined();
    expect(options.systemPrompt).toMatchObject({
      type: 'preset',
      preset: 'claude_code',
      append: expect.stringContaining('# SOC report evidence-first review'),
    });
    expect(options.agents).toHaveProperty('soc-report-evidence-reviewer');
    expect(options.tools).toEqual(['Read']);
    expect(options.mcpServers).toBeUndefined();
    expect(options.tools).not.toContain('Agent');
    expect(options.allowedTools).toEqual(options.tools);
    expect(options.tools).not.toContain('Bash');
    expect(options.disallowedTools).toContain('Agent');
    expect(options.permissionMode).toBe('dontAsk');
    expect(options.hooks?.PreToolUse).toBeDefined();
  });

});

describe('buildOptions — 입력 검증', () => {
  it('SOC phase 없는 비계약 세션을 거부한다', () => {
    expect(() => buildOptions(spec({ phase: undefined }))).toThrow(/contract phase/);
  });

  it('SOC 세션은 모호한 mission을 거부하고 계약별 권한만 노출한다', () => {
    expect(() => buildOptions(spec({ domain: 'soc', mission: undefined }))).toThrow(/모호/);
    const target = mkdtempSync(join(tmpdir(), 'nunchi-soc-session-target-'));
    const options = buildOptions(spec({
      domain: 'soc',
      mission: 'report',
      phase: 'evidence-review',
      target,
      allowedReadFiles: [join(target, '01_soc_report_snapshot.json')],
    }));
    expect(options.agent).toBeUndefined();
    expect(options.systemPrompt).toMatchObject({
      append: expect.stringContaining('# SOC report evidence-first review'),
    });
    expect(options.tools).toEqual(['Read']);
    expect(options.skills).toEqual(['nunchi-soc:soc-report-contract']);
    expect(options.mcpServers).toBeUndefined();
    expect(options.env?.AGENT_CONTRACT_ID).toBe('nunchi.soc.report');
    expect(options.env?.AGENT_MISSION).toBe('report');
  });



  it('상대경로 target 을 거부한다', () => {
    expect(() => buildOptions(spec({ target: 'relative/path' }))).toThrow(/절대경로/);
  });

  it('존재하지 않는 target 을 거부한다', () => {
    expect(() => buildOptions(spec({ target: '/nonexistent-nunchi-target-xyz' }))).toThrow(
      /진단 대상이 없다/,
    );
  });
});

describe('domainAgentNames — 위임 허용 집합', () => {




  it('soc 의 contract-bound 워커만 반환한다', () => {
    expect([...domainAgentNames('soc')].sort()).toEqual([
      'soc-investigation-evidence-reviewer',
      'soc-investigation-verifier',
      'soc-investigator',
      'soc-report-evidence-reviewer',
      'soc-report-verifier',
      'soc-reporter',
    ]);
  });

  it('빌트인 일반 목적 에이전트는 포함하지 않는다', () => {
    const names = domainAgentNames('soc');
    for (const builtin of ['general-purpose', 'Explore', 'Plan', 'claude']) {
      expect(names.has(builtin)).toBe(false);
    }
  });
});

describe('domainPluginPath', () => {
  it('SOC 플러그인 매니페스트가 존재한다', () => {
    expect(() => domainPluginPath('soc')).not.toThrow();
  });

  it('매니페스트가 없는 도메인은 즉시 실패한다 — 빈 세션을 조용히 띄우지 않는다', () => {
    const missing = DOMAINS.filter((d) => {
      try {
        domainPluginPath(d);
        return false;
      } catch {
        return true;
      }
    });
    for (const d of missing) {
      expect(() => domainPluginPath(d)).toThrow(/매니페스트가 없다/);
    }
  });
});

