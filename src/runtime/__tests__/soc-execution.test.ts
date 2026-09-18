import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const missions = vi.hoisted(() => ({ report: vi.fn(), investigation: vi.fn() }));
vi.mock('../missions/soc.js', () => ({ socReport: missions.report, socInvestigation: missions.investigation }));

import { executeSocSnapshot, redactionTrustFromEnv } from '../soc-execution.js';
import { compileSocInvestigationQueryPlan, createSocPreparedSnapshot } from '../soc-source.js';
import { investigationSnapshotFor, reportSnapshot, SOC_TEST_REDACTION_TRUST } from './soc-fixtures.js';

describe('standalone snapshot execution', () => {
  const authorization = { tenantId: 'tenant-1', actorId: 'actor-1', scopes: ['soc:report:read' as const] };
  const options = { engagementDir: join(mkdtempSync(join(tmpdir(), 'soc-execution-')), 'run') };
  const dependencies = { redactionTrust: SOC_TEST_REDACTION_TRUST };

  it('verifies the signed report before dispatching to the host mission', async () => {
    const snapshot = createSocPreparedSnapshot(reportSnapshot(), SOC_TEST_REDACTION_TRUST);
    await executeSocSnapshot(snapshot, authorization, options, dependencies);
    expect(missions.report).toHaveBeenCalledWith({ ...options, authorization, snapshot }, dependencies);
  });

  it('reconstructs the investigation query plan using a typed source adapter', async () => {
    const auth = { ...authorization, scopes: ['soc:investigation:read' as const] };
    const plan = compileSocInvestigationQueryPlan({ authorization: auth, subjects: [{ type: 'ip', value: '203.0.113.42' }], timeFrom: '2026-08-04T00:00:00.000Z', timeTo: '2026-08-04T01:00:00.000Z', providerSchema: { name: 'fixture', version: '1.0.0', adapterVersion: '1.0.0' } });
    const snapshot = createSocPreparedSnapshot(investigationSnapshotFor(plan), SOC_TEST_REDACTION_TRUST);
    await executeSocSnapshot(snapshot, auth, options, dependencies);
    const [input, source] = missions.investigation.mock.lastCall!;
    const { snapshotSha256: _hash, ...unsigned } = snapshot;
    expect(input.subjects).toEqual([{ type: 'ip', value: '203.0.113.42' }]);
    expect(await source.collect(plan, auth)).toEqual(unsigned);
  });

  it('rejects cross-tenant and cross-actor snapshots before model execution', async () => {
    const snapshot = createSocPreparedSnapshot(reportSnapshot(), SOC_TEST_REDACTION_TRUST);
    for (const auth of [{ ...authorization, tenantId: 'tenant-2' }, { ...authorization, actorId: 'actor-2' }]) {
      await expect(executeSocSnapshot(snapshot, auth, options, dependencies)).rejects.toThrow(/tenant\/actor/);
    }
  });

  it('rejects an untrusted signer and missing host trust configuration', async () => {
    const snapshot = createSocPreparedSnapshot(reportSnapshot(), SOC_TEST_REDACTION_TRUST);
    await expect(executeSocSnapshot(snapshot, authorization, options, { redactionTrust: { resolve: () => undefined } })).rejects.toThrow(/신뢰하지 않는다/);
    expect(() => redactionTrustFromEnv({})).toThrow(/SOC_REDACTION/);
  });
});
