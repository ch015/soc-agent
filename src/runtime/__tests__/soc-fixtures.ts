import { generateKeyPairSync } from 'node:crypto';

import type {
  SocPreparedSnapshotUnsigned,
  SocQueryPlan,
} from '../contracts/soc-schemas.js';
import { signSocRedactionReceipt, type SocRedactionTrustStore } from '../soc-redaction.js';

const SHA = 'a'.repeat(64);
const TEST_ISSUER = 'nunchi-test-redactor';
const TEST_KEY_ID = 'ed25519-test-1';
const TEST_KEYS = generateKeyPairSync('ed25519');

export const SOC_TEST_REDACTION_TRUST: SocRedactionTrustStore = {
  resolve: (issuer, keyId) => issuer === TEST_ISSUER && keyId === TEST_KEY_ID
    ? TEST_KEYS.publicKey
    : undefined,
};

export function attestSocSnapshotForTest(
  snapshot: Omit<SocPreparedSnapshotUnsigned, 'redactionReceipt'>,
  receiptId = 'redact-resigned-001',
): SocPreparedSnapshotUnsigned {
  return { ...snapshot, redactionReceipt: receipt(snapshot, receiptId) };
}

export function reportSnapshot(
  overrides: Partial<SocPreparedSnapshotUnsigned> = {},
): SocPreparedSnapshotUnsigned {
  const { redactionReceipt: _ignoredReceipt, ...safeOverrides } = overrides;
  const snapshot: Omit<SocPreparedSnapshotUnsigned, 'redactionReceipt'> = {
    schema: 'nunchi.soc.prepared-snapshot.v1',
    snapshotId: 'snap-report-001',
    mission: 'report',
    tenantId: 'tenant-1',
    actorId: 'actor-1',
    createdAt: '2026-08-04T00:30:00.000Z',
    timeFrom: '2026-08-04T00:00:00.000Z',
    timeTo: '2026-08-04T01:00:00.000Z',
    timezone: 'UTC',
    windowSemantics: 'half-open',
    providerSchema: { name: 'fixture', version: '1.0.0', adapterVersion: '1.0.0' },
    classification: 'internal',
    containsSecrets: false,
    containsRawPii: false,
    coverage: { complete: true, gaps: [] },
    queryReceipts: [{
      queryId: 'qry-01-signal-search',
      operation: 'signal-search',
      subject: { type: 'signal', value: 'signal-1' },
      tenantId: 'tenant-1',
      actorId: 'actor-1',
      timeFrom: '2026-08-04T00:00:00.000Z',
      timeTo: '2026-08-04T01:00:00.000Z',
      pages: 1,
      rows: 1,
      cursorExhausted: true,
      responseSha256: SHA,
    }],
    records: [{
      locator: 'rec-login-001',
      sourceQueryIds: ['qry-01-signal-search'],
      timestamp: '2026-08-04T00:10:00.000Z',
      kind: 'authentication',
      entityRefs: ['user:alice'],
      facts: { outcome: 'success', factor: 'mfa' },
    }],
    aggregates: [{
      locator: 'agg-login-count',
      sourceQueryIds: ['qry-01-signal-search'],
      metric: 'login_count',
      value: 1,
      dimensions: { outcome: 'success' },
    }],
    ...safeOverrides,
  };
  return attestSocSnapshotForTest(snapshot, 'redact-report-001');
}

export function investigationSnapshotFor(plan: SocQueryPlan): SocPreparedSnapshotUnsigned {
  const snapshot: Omit<SocPreparedSnapshotUnsigned, 'redactionReceipt'> = {
    schema: 'nunchi.soc.prepared-snapshot.v1',
    snapshotId: 'snap-investigation-001',
    mission: 'investigation',
    tenantId: plan.tenantId,
    actorId: plan.actorId,
    createdAt: '2026-08-04T00:30:00.000Z',
    timeFrom: plan.timeFrom,
    timeTo: plan.timeTo,
    timezone: 'UTC',
    windowSemantics: 'half-open',
    providerSchema: plan.providerSchema,
    classification: 'internal',
    containsSecrets: false,
    containsRawPii: false,
    coverage: { complete: true, gaps: [] },
    queryReceipts: plan.queries.map((query, index) => ({
      queryId: query.queryId,
      operation: query.operation,
      subject: query.subject,
      tenantId: plan.tenantId,
      actorId: plan.actorId,
      timeFrom: query.timeFrom,
      timeTo: query.timeTo,
      pages: 1,
      rows: index === 0 ? 1 : 0,
      cursorExhausted: true,
      responseSha256: SHA,
    })),
    records: [{
      locator: 'rec-network-001',
      sourceQueryIds: [plan.queries[0]!.queryId],
      timestamp: '2026-08-04T00:15:00.000Z',
      kind: 'network',
      entityRefs: ['ip:192.0.2.10'],
      facts: { direction: 'source', disposition: 'observed' },
    }],
    aggregates: [{
      locator: 'agg-event-count',
      sourceQueryIds: plan.queries.map((query) => query.queryId),
      metric: 'event_count',
      value: 1,
      dimensions: { subjectType: 'ip' },
    }],
  };
  return attestSocSnapshotForTest(snapshot, 'redact-investigation-001');
}

function receipt(
  snapshot: Omit<SocPreparedSnapshotUnsigned, 'redactionReceipt'>,
  receiptId: string,
) {
  return signSocRedactionReceipt(snapshot, {
    receiptId,
    policyId: 'soc-compact-v1',
    redactorVersion: 'fixture-1.0.0',
    sourcePayloadSha256: SHA,
    issuer: TEST_ISSUER,
    keyId: TEST_KEY_ID,
    issuedAt: '2026-08-04T00:30:00.000Z',
    fieldsRemoved: [],
    approved: true,
  }, TEST_KEYS.privateKey);
}
