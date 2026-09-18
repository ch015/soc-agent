import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';

const name = process.argv.slice(2).filter((arg) => arg !== '--').join(' ').trim();
if (!name || !process.env.DATABASE_URL) throw new Error('Usage: pnpm tenant:create <name> (DATABASE_URL required)');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  const apiKey = randomBytes(32).toString('hex');
  const { rows } = await pool.query('INSERT INTO tenants (name, api_key) VALUES ($1, $2) RETURNING id, name', [name, apiKey]);
  console.log(JSON.stringify({ ...rows[0], apiKey }, null, 2));
} finally { await pool.end(); }
