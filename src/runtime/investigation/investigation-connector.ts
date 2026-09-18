import type { SocSignal } from './signal.js';

export interface InvestigationConnector {
  capabilities?: readonly string[];
  execute(name: string, parameters: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

/** Adapter-owned mapping to SIEM/EDR APIs. Credentials and transport stay outside model input. */
export function createHttpToolConnector(input: {
  baseUrl: string; token: string; signal: SocSignal; fetchImpl?: typeof fetch;
}): InvestigationConnector {
  const base = new URL(input.baseUrl);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('invalid investigation connector URL');
  }
  return {
    async execute(name, parameters, signal) {
      const response = await (input.fetchImpl ?? fetch)(`${base.href.replace(/\/$/, '')}/tools/${encodeURIComponent(name)}`, {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.token}` },
        body: JSON.stringify({ version: '1', parameters, context: {
          signalId: input.signal.signalId, tenantId: input.signal.tenantId, timestamp: input.signal.timestamp,
        } }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error(`connector HTTP ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('empty connector response');
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 1_000_000) { await reader.cancel(); throw new Error('connector response too large; narrow the query'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid connector response');
      if ('error' in data && data.error) throw new Error('connector returned an error; this is unavailable evidence');
      return data;
    },
  };
}
