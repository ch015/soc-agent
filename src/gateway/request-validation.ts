import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

function badRequest(message: string): never {
  throw new HTTPException(400, { res: Response.json({ error: message }, { status: 400 }) });
}
export async function readJson(c: Context): Promise<unknown> {
  try { return await c.req.json(); } catch { return badRequest('Invalid JSON body'); }
}
export function requestId(value: string): string {
  if (!z.string().uuid().safeParse(value).success) badRequest('Invalid job ID');
  return value;
}
export function pagination(c: Context): { limit: number; offset: number } {
  const parse = (name: string, fallback: number, minimum: number, maximum: number) => {
    const raw = c.req.query(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) badRequest('Invalid pagination');
    return value;
  };
  return { limit: parse('limit', 50, 1, 1000), offset: parse('offset', 0, 0, Number.MAX_SAFE_INTEGER) };
}
