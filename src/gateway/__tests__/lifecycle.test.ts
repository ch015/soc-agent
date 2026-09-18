/** Unit tests for job lifecycle transitions. */
import { describe, it, expect } from 'vitest';

import {
  VALID_TRANSITIONS,
  canTransition,
  isTerminal,
  InvalidTransitionError,
} from '../job/lifecycle.js';
import type { JobStatus } from '../job/types.js';

describe('Job Lifecycle', () => {
  describe('VALID_TRANSITIONS', () => {
    it('defines transitions for all statuses', () => {
      const allStatuses: JobStatus[] = [
        'rejected', 'queued', 'running', 'waiting', 'completed', 'failed', 'cancelled',
      ];
      for (const status of allStatuses) {
        expect(VALID_TRANSITIONS).toHaveProperty(status);
        expect(Array.isArray(VALID_TRANSITIONS[status])).toBe(true);
      }
    });
  });

  describe('canTransition', () => {
    it('allows queued → running', () => {
      expect(canTransition('queued', 'running')).toBe(true);
    });

    it('allows queued → cancelled', () => {
      expect(canTransition('queued', 'cancelled')).toBe(true);
    });

    it('allows running → waiting', () => {
      expect(canTransition('running', 'waiting')).toBe(true);
    });

    it('allows running → completed', () => {
      expect(canTransition('running', 'completed')).toBe(true);
    });

    it('allows running → failed', () => {
      expect(canTransition('running', 'failed')).toBe(true);
    });

    it('allows running → cancelled', () => {
      expect(canTransition('running', 'cancelled')).toBe(true);
    });

    it('allows waiting → running', () => {
      expect(canTransition('waiting', 'running')).toBe(true);
    });

    it('allows waiting → failed', () => {
      expect(canTransition('waiting', 'failed')).toBe(true);
    });

    it('allows waiting → cancelled', () => {
      expect(canTransition('waiting', 'cancelled')).toBe(true);
    });

    it('allows failed → queued (retry)', () => {
      expect(canTransition('failed', 'queued')).toBe(true);
    });

    it('rejects completed → anything', () => {
      expect(canTransition('completed', 'running')).toBe(false);
      expect(canTransition('completed', 'queued')).toBe(false);
      expect(canTransition('completed', 'failed')).toBe(false);
    });

    it('rejects rejected → anything', () => {
      expect(canTransition('rejected', 'queued')).toBe(false);
      expect(canTransition('rejected', 'running')).toBe(false);
    });

    it('rejects cancelled → anything', () => {
      expect(canTransition('cancelled', 'running')).toBe(false);
      expect(canTransition('cancelled', 'queued')).toBe(false);
    });

    it('rejects queued → completed (must go through running)', () => {
      expect(canTransition('queued', 'completed')).toBe(false);
    });

    it('rejects queued → waiting', () => {
      expect(canTransition('queued', 'waiting')).toBe(false);
    });

    it('rejects running → queued', () => {
      expect(canTransition('running', 'queued')).toBe(false);
    });
  });

  describe('isTerminal', () => {
    it('returns true for terminal states', () => {
      expect(isTerminal('completed')).toBe(true);
      expect(isTerminal('rejected')).toBe(true);
      expect(isTerminal('cancelled')).toBe(true);
    });

    it('returns false for non-terminal states', () => {
      expect(isTerminal('queued')).toBe(false);
      expect(isTerminal('running')).toBe(false);
      expect(isTerminal('waiting')).toBe(false);
      expect(isTerminal('failed')).toBe(false);
    });
  });

  describe('InvalidTransitionError', () => {
    it('contains from and to properties', () => {
      const error = new InvalidTransitionError('queued', 'completed');
      expect(error.from).toBe('queued');
      expect(error.to).toBe('completed');
      expect(error.message).toContain('queued');
      expect(error.message).toContain('completed');
      expect(error.name).toBe('InvalidTransitionError');
    });
  });
});
