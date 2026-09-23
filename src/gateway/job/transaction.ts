import type { PgPool, PgQuery } from './store.js';

export async function transaction<T>(pool: PgPool, operation: (client: PgQuery) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (cause) { broken = cause instanceof Error ? cause : new Error(String(cause)); }
    throw error;
  } finally { client.release(broken); }
}
