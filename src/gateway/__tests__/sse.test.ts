/** Unit tests for SSE event formatting. */
import { describe, it, expect } from 'vitest';

import { formatSSE, formatHeartbeat } from '../stream/sse.js';

describe('SSE Formatting', () => {
  describe('formatSSE', () => {
    it('formats a complete event with id, event, and data', () => {
      const result = formatSSE({
        id: '42',
        event: 'status',
        data: '{"status":"running"}',
      });
      expect(result).toBe('id: 42\nevent: status\ndata: {"status":"running"}\n\n');
    });

    it('formats an event without id', () => {
      const result = formatSSE({
        event: 'progress',
        data: '{"phase":"검토 중","percent":50}',
      });
      expect(result).toBe('event: progress\ndata: {"phase":"검토 중","percent":50}\n\n');
    });

    it('formats an event without event type', () => {
      const result = formatSSE({
        id: '1',
        data: '{"message":"hello"}',
      });
      expect(result).toBe('id: 1\ndata: {"message":"hello"}\n\n');
    });

    it('formats data-only event', () => {
      const result = formatSSE({ data: 'simple message' });
      expect(result).toBe('data: simple message\n\n');
    });

    it('ends with double newline (SSE spec)', () => {
      const result = formatSSE({ id: '1', event: 'test', data: '{}' });
      expect(result.endsWith('\n\n')).toBe(true);
    });

    it('handles completed event', () => {
      const result = formatSSE({
        id: '45',
        event: 'completed',
        data: JSON.stringify({ summary: '보안 이슈 2건 발견', reportUrl: 'https://example.com/report' }),
      });
      expect(result).toContain('id: 45');
      expect(result).toContain('event: completed');
      expect(result).toContain('보안 이슈 2건 발견');
    });

    it('handles waiting event with questions', () => {
      const data = JSON.stringify({
        requestId: 'req-001',
        questions: ['인증 흐름 시퀀스가 필요합니다'],
      });
      const result = formatSSE({ id: '44', event: 'waiting', data });
      expect(result).toContain('event: waiting');
      expect(result).toContain('인증 흐름 시퀀스가 필요합니다');
    });
  });

  describe('formatHeartbeat', () => {
    it('produces a valid SSE comment', () => {
      const result = formatHeartbeat();
      expect(result).toBe(': heartbeat\n\n');
    });

    it('starts with colon (SSE comment marker)', () => {
      const result = formatHeartbeat();
      expect(result.startsWith(':')).toBe(true);
    });

    it('ends with double newline', () => {
      const result = formatHeartbeat();
      expect(result.endsWith('\n\n')).toBe(true);
    });
  });
});
