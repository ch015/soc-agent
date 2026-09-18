/** Signal → SocQueryPlan: time range from timeContext/suggestedWindow, subject-based filter. */
import type { SocSignal } from './types.js';

export interface SocQueryPlan {
  /** Elasticsearch index pattern to query. */
  index: string;
  /** Time range for the query. */
  timeRange: {
    gte: string;
    lte: string;
  };
  /** Filters derived from signal subject. */
  filters: Array<{ field: string; value: string }>;
  /** Optional rule-based additional filter. */
  ruleFilter?: { field: string; value: string };
  /** Maximum rows to collect. */
  maxRows: number;
  /** Query timeout in milliseconds. */
  timeoutMs: number;
}

/** Maximum query window: 24 hours. */
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Default lookback window if no timeContext: 1 hour. */
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;

/** Max rows per §5.2. */
const MAX_ROWS = 10_000;

/** Query timeout per §5.2. */
const QUERY_TIMEOUT_MS = 60_000;

/**
 * Build a query plan from a SocSignal.
 * Uses timeContext for range, subject for filters, rule for additional scoping.
 */
export function buildQueryPlan(signal: SocSignal, index?: string): SocQueryPlan {
  // Determine time range
  const { gte, lte } = resolveTimeRange(signal);

  // Build subject filter
  const filters = buildSubjectFilters(signal);

  // Optional rule filter
  const ruleFilter = signal.rule
    ? { field: 'rule.id', value: signal.rule.id }
    : undefined;

  return {
    index: index ?? '*',
    timeRange: { gte, lte },
    filters,
    ruleFilter,
    maxRows: MAX_ROWS,
    timeoutMs: QUERY_TIMEOUT_MS,
  };
}

function resolveTimeRange(signal: SocSignal): { gte: string; lte: string } {
  if (signal.timeContext) {
    const { firstSeen, lastSeen, suggestedWindow } = signal.timeContext;

    if (suggestedWindow) {
      const windowMs = parseWindow(suggestedWindow);
      const effectiveWindow = Math.min(windowMs, MAX_WINDOW_MS);
      const lastSeenDate = new Date(lastSeen);
      const gte = new Date(lastSeenDate.getTime() - effectiveWindow).toISOString();
      return { gte, lte: lastSeen };
    }

    // Use firstSeen → lastSeen directly, capped at MAX_WINDOW_MS
    const firstMs = new Date(firstSeen).getTime();
    const lastMs = new Date(lastSeen).getTime();
    const rangeMs = lastMs - firstMs;

    if (rangeMs > MAX_WINDOW_MS) {
      const gte = new Date(lastMs - MAX_WINDOW_MS).toISOString();
      return { gte, lte: lastSeen };
    }

    return { gte: firstSeen, lte: lastSeen };
  }

  // No timeContext — use default window before signal timestamp
  const tsMs = new Date(signal.timestamp).getTime();
  const gte = new Date(tsMs - DEFAULT_WINDOW_MS).toISOString();
  return { gte, lte: signal.timestamp };
}

function buildSubjectFilters(signal: SocSignal): Array<{ field: string; value: string }> {
  const { type, value } = signal.subject;

  // Map subject type to typical log field names
  const fieldMap: Record<string, string> = {
    ip: 'source.ip',
    user: 'user.name',
    host: 'host.name',
    service: 'service.name',
    domain: 'dns.question.name',
    hash: 'file.hash.sha256',
  };

  const field = fieldMap[type] ?? type;
  return [{ field, value }];
}

/**
 * Parse duration string like '1h', '24h', '30m', '5m' into milliseconds.
 */
function parseWindow(window: string): number {
  const match = window.match(/^(\d+)(h|m|s|d)$/);
  if (!match) return DEFAULT_WINDOW_MS;

  const amount = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case 's': return amount * 1000;
    case 'm': return amount * 60 * 1000;
    case 'h': return amount * 60 * 60 * 1000;
    case 'd': return amount * 24 * 60 * 60 * 1000;
    default: return DEFAULT_WINDOW_MS;
  }
}
