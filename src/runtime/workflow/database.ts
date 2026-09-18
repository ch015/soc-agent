import { Pool } from 'pg';

import type { SqlPool } from './run-lease.js';

export type DatabaseEnvironment = Record<string, string | undefined>;

export function databaseUrlFromEnv(env: DatabaseEnvironment = process.env): string {
  const value = env.NUNCHI_DATABASE_URL ?? env.DATABASE_URL;
  if (!value) {
    throw new Error('NUNCHI_DATABASE_URL 또는 DATABASE_URL이 필요하다');
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PostgreSQL database URL 형식이 잘못됐다');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`PostgreSQL database URL이 아니다: ${url.protocol}`);
  }
  return value;
}

export function createPostgresPool(env: DatabaseEnvironment = process.env): Pool & SqlPool {
  const configuredMax = env.NUNCHI_DB_POOL_MAX === undefined ? 10 : Number(env.NUNCHI_DB_POOL_MAX);
  if (!Number.isInteger(configuredMax) || configuredMax < 1 || configuredMax > 100) {
    throw new Error(`NUNCHI_DB_POOL_MAX가 잘못됐다: ${env.NUNCHI_DB_POOL_MAX}`);
  }
  return new Pool({
    connectionString: databaseUrlFromEnv(env),
    max: configuredMax,
    application_name: env.NUNCHI_DB_APPLICATION_NAME ?? 'secops-soc-agent',
  });
}
