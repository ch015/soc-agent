import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { readSocPreparedSnapshotPage } from '../src/runtime/soc-cli.js';

function parseArgs(argv: readonly string[]): Parameters<typeof readSocPreparedSnapshotPage>[0] {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith('--')) throw new Error(`알 수 없는 SOC CLI 인수: ${arg}`);
    const key = arg.slice(2);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`SOC CLI 인수 값이 없다: --${key}`);
    if (values.has(key)) throw new Error(`SOC CLI 인수가 중복됐다: --${key}`);
    values.set(key, value);
  }
  const path = required(values, 'snapshot');
  const mission = required(values, 'mission') as 'report' | 'investigation';
  const tenantId = required(values, 'tenant');
  const actorId = required(values, 'actor');
  const scope = values.get('scope') ?? (mission === 'report' ? 'soc:report:read' : 'soc:investigation:read');
  const scopes = scope.split(',').map((value) => value.trim()).filter(Boolean);
  const trustedIssuer = required(values, 'redaction-issuer');
  const trustedKeyId = required(values, 'redaction-key-id');
  const publicKey = createPublicKey(readFileSync(required(values, 'redaction-public-key')));
  return {
    path,
    mission,
    authorization: { tenantId, actorId, scopes: scopes as ['soc:report:read'] | ['soc:investigation:read'] },
    redactionTrust: {
      resolve: (issuer, keyId) => issuer === trustedIssuer && keyId === trustedKeyId ? publicKey : undefined,
    },
    ...(values.has('page') ? { page: numberArg(values, 'page') } : {}),
    ...(values.has('page-size') ? { pageSize: numberArg(values, 'page-size') } : {}),
    ...(values.has('max-rows') ? { maxRows: numberArg(values, 'max-rows') } : {}),
    ...(values.has('rate-limit-per-minute')
      ? { rateLimitPerMinute: numberArg(values, 'rate-limit-per-minute') }
      : {}),
  };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`SOC CLI 필수 인수가 없다: --${key}`);
  return value;
}

function numberArg(values: Map<string, string>, key: string): number {
  const value = Number(required(values, key));
  if (!Number.isInteger(value)) throw new Error(`SOC CLI 숫자 인수가 잘못됐다: --${key}`);
  return value;
}

try {
  console.log(JSON.stringify(readSocPreparedSnapshotPage(parseArgs(process.argv.slice(2))), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
