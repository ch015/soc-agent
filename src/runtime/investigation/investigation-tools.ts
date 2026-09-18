import { z } from 'zod';
import type { SocSignal } from './signal.js';
import type { InvestigationTool } from './agent-loop.js';
import { createHttpToolConnector, type InvestigationConnector } from './investigation-connector.js';

const rationale = {
  reason: z.string().min(8).max(400).describe('The unresolved question this action answers and how its result could change the assessment.'),
  evidenceIds: z.array(z.string().min(1)).min(1).max(8).describe('Existing signal/observation IDs that justify this action. Expansion must follow an observed relationship.'),
};
const entity = {
  entityType: z.enum(['ip', 'principal', 'host', 'resource', 'service']),
  entityValue: z.string().min(1).max(256),
};

export function createInvestigationTools(input: {
  signal: SocSignal;
  baseUrl?: string;
  token?: string;
  fetchImpl?: typeof fetch;
  /** Default preserves the nunchi-core REST API. http-json uses the portable tool gateway. */
  connector?: 'nunchi-core' | 'http-json' | InvestigationConnector;
  capabilities?: readonly string[];
}): InvestigationTool[] {
  const fetchImpl = input.fetchImpl ?? fetch;
  const base = input.baseUrl?.replace(/\/$/, '') ?? '';
  if (typeof input.connector !== 'object' && !base) throw new Error('baseUrl or a custom connector is required');
  const connector = typeof input.connector === 'object' ? input.connector
    : input.connector === 'http-json' ? createHttpToolConnector({ ...input, baseUrl: base, token: input.token ?? '' }) : undefined;
  const capabilities = input.capabilities ?? connector?.capabilities;
  const request = async (path: string, signal: AbortSignal, body?: unknown) => {
    const response = await fetchImpl(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`SIEM HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (!reader) throw new Error('empty SIEM response');
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 1_000_000) { await reader.cancel(); throw new Error('SIEM response too large; narrow the query'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid SIEM response');
    if (data.error) throw new Error('SIEM returned an error; this is unavailable evidence');
    return data;
  };
  const define = <S extends z.ZodRawShape>(name: string, description: string, fields: S,
    execute: (args: z.infer<z.ZodObject<S & typeof rationale>>, signal: AbortSignal) => Promise<unknown>): InvestigationTool => {
    const schema = z.object({ ...fields, ...rationale }).strict();
    return { name, description, input_schema: z.toJSONSchema(schema) as Record<string, unknown>,
      parseInput: value => schema.parse(value), execute: (args, signal) => {
        const parsed = schema.parse(args);
        const { reason: _reason, evidenceIds: _refs, ...parameters } = parsed as Record<string, unknown>;
        return connector ? connector.execute(name, parameters, signal) : execute(parsed, signal);
      } };
  };
  const tools = [
    define('get_signal', 'Read details of the triggering signal or a related signal observed in evidence. Use when the initial signal omits facts needed for the decision. Do not reread unchanged signals.',
      { signalId: z.string().min(1).max(256) }, (args, signal) => request(`/api/v1/signals/${encodeURIComponent(args.signalId)}`, signal)),
    define('get_rule', 'Read the detection logic and context of a rule. Use when understanding why the signal fired could distinguish malicious behavior from normal activity. Skip if the rule context is already sufficient.',
      { ruleId: z.string().min(1).max(256) }, (args, signal) => request(`/api/v1/rules/${encodeURIComponent(args.ruleId)}`, signal)),
    define('get_event_fields', 'Read supported query fields and syntax before constructing an unfamiliar query (NQL for nunchi-core). Reuse the metadata. This is metadata, not evidence that an event occurred.',
      {}, (_args, signal) => request('/api/v1/events/query-fields', signal)),
    define('search_events', 'Search events using the syntax supported by get_event_fields (NQL for nunchi-core) for one concrete hypothesis. Start with a narrow time window and small page. Expand only for a decision-relevant question; times are relative to the signal.',
      { query: z.string().min(1).max(2000), minutesBefore: z.number().int().min(1).max(10080).default(30),
        minutesAfter: z.number().int().min(0).max(60).default(0), page: z.number().int().min(1).max(10).default(1),
        size: z.number().int().min(1).max(100).default(20) },
      (args, signal) => request('/api/v1/events/search/query', signal, {
        query: { version: '1', text: args.query },
        time_from: new Date(Date.parse(input.signal.timestamp) - args.minutesBefore * 60_000).toISOString(),
        time_to: new Date(Date.parse(input.signal.timestamp) + args.minutesAfter * 60_000).toISOString(),
        page: args.page, size: args.size,
      })),
    define('get_threat_intel', 'Search threat indicators for an observed IP, domain, hash or URL. The backend performs a text search: check returned indicator values for an exact relevant match; total alone is not a match. Do not query user names as threat indicators.',
      { indicator: z.string().min(1).max(200) },
      (args, signal) => request(`/api/v1/threat-intel/indicators?search=${encodeURIComponent(args.indicator)}&limit=20`, signal)),
    define('get_identity', 'Read an observed identity ID to clarify account ownership or context. Use an actual identity identifier found in evidence, not an invented account ID. Skip for IP-only investigations without an account relationship.',
      { identityId: z.string().min(1).max(256) }, (args, signal) => request(`/api/v1/identities/${encodeURIComponent(args.identityId)}`, signal)),
    define('investigate_entity', 'Retrieve related alerts, cases and events for an entity grounded in existing evidence. Use principal for user accounts. Investigate only relationships relevant to the active hypothesis, not every entity returned.',
      { ...entity, period: z.enum(['1h', '24h', '7d']).default('24h') },
      (args, signal) => request(`/api/v1/investigate/entity?${new URLSearchParams({ entity_type: args.entityType, entity_value: args.entityValue, period: args.period })}`, signal)),
    define('get_entity_graph', 'Traverse relationships of an observed entity when a relationship question matters. Begin with one hop and a small node cap. Returned relationships suggest follow-up targets; they do not themselves prove compromise.',
      { ...entity, maxHops: z.number().int().min(1).max(3).default(1), maxNodes: z.number().int().min(1).max(100).default(30) },
      (args, signal) => request('/api/v1/graph/traverse', signal, {
        entity_type: args.entityType, entity_value: args.entityValue, max_hops: args.maxHops, max_nodes: args.maxNodes,
      })),
  ];
  if (capabilities?.some(name => !tools.some(tool => tool.name === name))) throw new Error('unknown investigation capability');
  return tools.filter(tool => !capabilities || capabilities.includes(tool.name));
}
