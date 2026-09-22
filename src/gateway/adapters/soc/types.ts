/** SOC signal types and zod schemas per design §4.1. */
import { z } from 'zod';

import type { SocSignal, SocSeverity } from '../../../runtime/investigation/signal.js';
export { SocSignalSchema, SocSeverity, type SocSignal } from '../../../runtime/investigation/signal.js';

// ─── Priority Mapping (§4.2) ────────────────────────────────────────────────

/** BullMQ priority: lower number = higher priority. */
export const SEVERITY_PRIORITY_MAP: Record<SocSeverity, number> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
  info: 5,
};

// ─── Signal Deduplication Interface (§4.3) ──────────────────────────────────

export interface SignalDeduplication {
  /** Check if signalId has been seen before. Returns true if duplicate. */
  bySignalId(tenantId: string, signalId: string): Promise<boolean>;

  /**
   * Check correlation: same subject + rule within 5min window.
   * Returns existing jobId if correlated, null otherwise.
   */
  byCorrelation(signal: SocSignal): Promise<string | null>;
}

// ─── Advisory Action types ──────────────────────────────────────────────────

export type ActionCategory = 'observe' | 'contain' | 'eradicate' | 'recover';

export interface AdvisoryAction {
  actionKey: string;
  actionType: string;
  category: ActionCategory;
  target: string;
  severity: SocSeverity;
  confidence: number;
  evidenceLocators: string[];
  params?: Record<string, unknown>;
}
