import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pool } from 'pg';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: url });
try {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('secops-soc-schema'))");
    await client.query('CREATE TABLE IF NOT EXISTS soc_schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const name of ['src/gateway/migrations/001-initial.sql', 'src/gateway/migrations/002-soc.sql', 'src/runtime/workflow/postgres-run-state.sql']) {
      const sql = readFileSync(resolve(import.meta.dirname, '..', name), 'utf8');
      const sha256 = createHash('sha256').update(sql).digest('hex');
      const { rows } = await client.query<{ sha256: string }>('SELECT sha256 FROM soc_schema_migrations WHERE name = $1', [name]);
      if (rows.length) {
        if (rows[0]!.sha256 !== sha256) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO soc_schema_migrations (name, sha256) VALUES ($1, $2)', [name, sha256]);
      console.log(`Applied ${name}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
} finally { await pool.end(); }
