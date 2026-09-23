import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, it } from 'vitest';
import { PostgresRunLeaseBackend } from '../workflow/run-lease.js';
const url = process.env.NUNCHI_DATABASE_URL;
it.skipIf(!url)('releases a standalone-schema lease and retains monotonic fencing', async () => {
  const schema = 'lease_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: url });
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(readFileSync(new URL('../workflow/postgres-run-lease.sql', import.meta.url), 'utf8'));
    const backend = new PostgresRunLeaseBackend(pool);
    const first = await backend.acquire({ runId: 'fixture', ownerId: 'first', ttlMs: 60000 });
    await backend.release(first);
    const second = await backend.acquire({ runId: 'fixture', ownerId: 'second', ttlMs: 60000 });
    expect(second.fencingToken).toBe(first.fencingToken + 1);
    await backend.release(first);
    await backend.assertActive(second);
    await expect(backend.assertActive(first)).rejects.toThrow();
    await backend.release(second);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
});
