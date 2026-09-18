/**
 * LiveSocSourceAdapter — queries ES/OpenSearch via REST API.
 * Enforces §5.2 limits: 24h window, 10k rows, 50MB, 60s timeout.
 */
import type { SocSignal } from './types.js';
import { buildQueryPlan } from './query-builder.js';
import type { SocQueryPlan } from './query-builder.js';

export interface SocAuthorizationContext {
  endpoint: string;
  credentialRef?: string;
  bearerToken?: string;
  index?: string;
}

export interface SocCollectedRow {
  _id: string;
  _index: string;
  _source: Record<string, unknown>;
}

export interface SocPreparedSnapshot {
  rows: SocCollectedRow[];
  totalHits: number;
  bytesCollected: number;
  queryPlan: SocQueryPlan;
  collectedAt: string;
  truncated: boolean;
}

/** §5.2 limits. */
const LIMITS = {
  maxRows: 10_000,
  maxBytes: 50 * 1024 * 1024, // 50MB
  timeoutMs: 60_000,
  rateLimitPerSec: 10,
} as const;

/** Minimum interval between requests (ms) for rate limiting. */
const RATE_INTERVAL = Math.ceil(1000 / LIMITS.rateLimitPerSec);

/**
 * LiveSocSourceAdapter — collects logs from Elasticsearch/OpenSearch.
 */
export class LiveSocSourceAdapter {
  readonly sourceType = 'elasticsearch' as const;

  /**
   * Build a query plan from a signal for log collection.
   */
  buildQueryPlan(signal: SocSignal, index?: string): SocQueryPlan {
    return buildQueryPlan(signal, index);
  }

  /**
   * Collect logs from ES endpoint with pagination, rate limiting, and limits enforcement.
   */
  async collect(plan: SocQueryPlan, auth: SocAuthorizationContext): Promise<SocPreparedSnapshot> {
    const rows: SocCollectedRow[] = [];
    let totalHits = 0;
    let bytesCollected = 0;
    let truncated = false;
    let scrollId: string | undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (auth.bearerToken) {
      headers['Authorization'] = `Bearer ${auth.bearerToken}`;
    }

    const index = auth.index ?? plan.index;
    const baseUrl = auth.endpoint.replace(/\/$/, '');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), plan.timeoutMs || LIMITS.timeoutMs);

    try {
      // Initial search with scroll
      const searchBody = buildEsQuery(plan);
      const searchUrl = `${baseUrl}/${encodeURIComponent(index)}/_search?scroll=1m`;

      const initialResponse = await fetch(searchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(searchBody),
        signal: controller.signal,
      });

      if (!initialResponse.ok) {
        throw new Error(`ES query failed: ${initialResponse.status} ${initialResponse.statusText}`);
      }

      const initialResult = await initialResponse.json() as EsSearchResponse;
      totalHits = typeof initialResult.hits.total === 'number'
        ? initialResult.hits.total
        : initialResult.hits.total.value;
      scrollId = initialResult._scroll_id;

      // Process initial batch
      for (const hit of initialResult.hits.hits) {
        const rowBytes = JSON.stringify(hit._source).length;
        if (bytesCollected + rowBytes > LIMITS.maxBytes) {
          truncated = true;
          break;
        }
        if (rows.length >= LIMITS.maxRows) {
          truncated = true;
          break;
        }
        rows.push({ _id: hit._id, _index: hit._index, _source: hit._source });
        bytesCollected += rowBytes;
      }

      // Scroll for more if needed and not truncated
      while (!truncated && scrollId && rows.length < Math.min(totalHits, LIMITS.maxRows)) {
        await delay(RATE_INTERVAL);

        const scrollUrl = `${baseUrl}/_search/scroll`;
        const scrollResponse = await fetch(scrollUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ scroll: '1m', scroll_id: scrollId }),
          signal: controller.signal,
        });

        if (!scrollResponse.ok) break;

        const scrollResult = await scrollResponse.json() as EsSearchResponse;
        scrollId = scrollResult._scroll_id;

        if (scrollResult.hits.hits.length === 0) break;

        for (const hit of scrollResult.hits.hits) {
          const rowBytes = JSON.stringify(hit._source).length;
          if (bytesCollected + rowBytes > LIMITS.maxBytes) {
            truncated = true;
            break;
          }
          if (rows.length >= LIMITS.maxRows) {
            truncated = true;
            break;
          }
          rows.push({ _id: hit._id, _index: hit._index, _source: hit._source });
          bytesCollected += rowBytes;
        }
      }

      // Clear scroll
      if (scrollId) {
        await fetch(`${baseUrl}/_search/scroll`, {
          method: 'DELETE',
          headers,
          body: JSON.stringify({ scroll_id: scrollId }),
        }).catch(() => { /* best effort */ });
      }
    } finally {
      clearTimeout(timeout);
    }

    return {
      rows,
      totalHits,
      bytesCollected,
      queryPlan: plan,
      collectedAt: new Date().toISOString(),
      truncated,
    };
  }
}

// ─── ES Query Builder ───────────────────────────────────────────────────────

function buildEsQuery(plan: SocQueryPlan): Record<string, unknown> {
  const must: Array<Record<string, unknown>> = [];

  // Time range filter
  must.push({
    range: {
      '@timestamp': {
        gte: plan.timeRange.gte,
        lte: plan.timeRange.lte,
      },
    },
  });

  // Subject filters
  for (const filter of plan.filters) {
    must.push({ term: { [filter.field]: filter.value } });
  }

  // Rule filter
  if (plan.ruleFilter) {
    must.push({ term: { [plan.ruleFilter.field]: plan.ruleFilter.value } });
  }

  return {
    size: 1000, // Per-scroll page size
    query: {
      bool: { must },
    },
    sort: [{ '@timestamp': 'asc' }],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── ES Response Types ──────────────────────────────────────────────────────

interface EsHit {
  _id: string;
  _index: string;
  _source: Record<string, unknown>;
}

interface EsSearchResponse {
  _scroll_id?: string;
  hits: {
    total: number | { value: number; relation: string };
    hits: EsHit[];
  };
}
