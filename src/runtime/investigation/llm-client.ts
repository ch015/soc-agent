/** Native Messages tool protocol. Investigation order belongs to the model. */
export type Message = { role: 'user' | 'assistant'; content: string | Array<Record<string, unknown>> };
export type ToolDefinition = { name: string; description: string; input_schema: Record<string, unknown> };
export interface LlmClientOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Cache the stable tools/system prefix; inputTokens includes all cache categories. */
  promptCaching?: boolean;
}
export class SocLlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly promptCaching: boolean;
  constructor(opts: LlmClientOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.model = opts.model ?? (process.env.SOC_LLM_MODEL || 'claude-haiku-4-5-20251001');
    this.maxTokens = opts.maxTokens ?? 2048;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.promptCaching = opts.promptCaching ?? true;
  }
  get enabled(): boolean { return this.apiKey.length > 0; }
  async completeTurn(input: {
    system: string; messages: Message[]; tools: ToolDefinition[]; signal: AbortSignal; allowTools?: boolean;
  }): Promise<{
    content: Array<Record<string, unknown>>; stopReason: string;
    usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  }> {
    if (!this.enabled) throw new Error('SOC model is not configured');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: this.model, max_tokens: this.maxTokens, system: this.promptCaching
            ? [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }] : input.system, messages: input.messages,
          ...(input.tools.length ? { tools: input.tools, tool_choice: { type: input.allowTools === false ? 'none' : 'auto' } } : {}),
        }),
        signal: AbortSignal.any([input.signal, controller.signal]),
      });
      if (!response.ok) throw new Error(`SOC model HTTP ${response.status}`);
      const data = await response.json() as {
        content?: Array<Record<string, unknown>>; stop_reason?: string;
        usage?: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
      };
      const counts = [data.usage?.input_tokens, data.usage?.output_tokens,
        data.usage?.cache_creation_input_tokens ?? 0, data.usage?.cache_read_input_tokens ?? 0];
      if (!Array.isArray(data.content) || counts.some(value => !Number.isSafeInteger(value) || value! < 0)) {
        throw new Error('SOC model returned an invalid response');
      }
      const [uncached, output, cacheWrite, cacheRead] = counts as number[];
      return { content: data.content, stopReason: data.stop_reason ?? 'unknown',
        usage: { inputTokens: uncached! + cacheWrite! + cacheRead!, outputTokens: output!,
          cacheReadTokens: cacheRead!, cacheWriteTokens: cacheWrite! } };
    } finally { clearTimeout(timer); }
  }
}
