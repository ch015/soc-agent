import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { SocAuthorizationContext } from '../contracts/soc-schemas.js';
import { readSocPreparedSnapshotPage as readTrustedSocPreparedSnapshotPage } from '../soc-cli.js';
import {
  materializeSocPreparedSnapshot as materializeTrustedSocPreparedSnapshot,
  createSocPreparedSnapshot as createTrustedSocPreparedSnapshot,
} from '../soc-source.js';
import { reportSnapshot, SOC_TEST_REDACTION_TRUST } from './soc-fixtures.js';

const createSocPreparedSnapshot = (input: Parameters<typeof createTrustedSocPreparedSnapshot>[0]) =>
  createTrustedSocPreparedSnapshot(input, SOC_TEST_REDACTION_TRUST);
const materializeSocPreparedSnapshot = (
  input: Omit<Parameters<typeof materializeTrustedSocPreparedSnapshot>[0], 'redactionTrust'>,
) => materializeTrustedSocPreparedSnapshot({ ...input, redactionTrust: SOC_TEST_REDACTION_TRUST });
const readSocPreparedSnapshotPage = (
  input: Omit<Parameters<typeof readTrustedSocPreparedSnapshotPage>[0], 'redactionTrust'>,
) => readTrustedSocPreparedSnapshotPage({ ...input, redactionTrust: SOC_TEST_REDACTION_TRUST });

const authorization: SocAuthorizationContext = {
  tenantId: 'tenant-1',
  actorId: 'actor-1',
  scopes: ['soc:report:read'],
};

describe('SOC prepared snapshot CLI boundary', () => {
  it('loads only sealed snapshots and paginates compact records with receipt metadata', () => {
    const engagementDir = mkdtempSync(join(tmpdir(), 'nunchi-soc-cli-'));
    const snapshot = createSocPreparedSnapshot(reportSnapshot({
      records: [
        ...reportSnapshot().records,
        { ...reportSnapshot().records[0]!, locator: 'rec-login-002' },
      ],
    }));
    const materialized = materializeSocPreparedSnapshot({
      value: snapshot,
      mission: 'report',
      authorization,
      engagementDir,
    });
    const page = readSocPreparedSnapshotPage({
      path: materialized.path,
      mission: 'report',
      authorization,
      page: 2,
      pageSize: 1,
      rateLimitPerMinute: 1,
    });
    expect(page.records.map((record) => record.locator)).toEqual(['rec-login-002']);
    expect(page.totalPages).toBe(2);
    expect(page.redactionReceipt.approved).toBe(true);
    expect(page.requestsConsumed).toBe(1);
  });

  it('fails closed for tenant mismatch, missing receipt, and row-limit overflow', () => {
    const engagementDir = mkdtempSync(join(tmpdir(), 'nunchi-soc-cli-'));
    const snapshot = createSocPreparedSnapshot(reportSnapshot());
    const materialized = materializeSocPreparedSnapshot({
      value: snapshot,
      mission: 'report',
      authorization,
      engagementDir,
    });
    expect(() => readSocPreparedSnapshotPage({
      path: materialized.path,
      mission: 'report',
      authorization: { ...authorization, tenantId: 'tenant-2' },
    })).toThrow(/tenant/);
    expect(() => readSocPreparedSnapshotPage({
      path: materialized.path,
      mission: 'report',
      authorization,
      maxRows: 0,
    })).toThrow();
    const withoutReceiptPath = join(engagementDir, 'without-receipt.json');
    const withoutReceipt = JSON.parse(readFileSync(materialized.path, 'utf8')) as Record<string, unknown>;
    delete withoutReceipt.redactionReceipt;
    writeFileSync(withoutReceiptPath, JSON.stringify(withoutReceipt));
    expect(() => readSocPreparedSnapshotPage({
      path: withoutReceiptPath,
      mission: 'report',
      authorization,
    })).toThrow(/redactionReceipt/);
  });

  it('rejects a forged redaction signature even when the snapshot hash is recomputed', () => {
    const engagementDir = mkdtempSync(join(tmpdir(), 'nunchi-soc-cli-forged-'));
    const materialized = materializeSocPreparedSnapshot({
      value: createSocPreparedSnapshot(reportSnapshot()), mission: 'report', authorization, engagementDir,
    });
    const forged = JSON.parse(readFileSync(materialized.path, 'utf8')) as Record<string, unknown>;
    const receipt = forged.redactionReceipt as Record<string, unknown>;
    receipt.signatureBase64 = Buffer.alloc(64).toString('base64');
    const { snapshotSha256: _ignored, ...unsigned } = forged;
    forged.snapshotSha256 = createHash('sha256').update(`${JSON.stringify(unsigned)}\n`).digest('hex');
    writeFileSync(materialized.path, `${JSON.stringify(forged)}\n`);
    expect(() => readSocPreparedSnapshotPage({
      path: materialized.path, mission: 'report', authorization,
    })).toThrow(/signature/);
  });
});
