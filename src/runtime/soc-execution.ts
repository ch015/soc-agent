import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { SocPreparedSnapshotSchema, type SocAuthorizationContext } from './contracts/soc-schemas.js';
import { socInvestigation, socReport, type SocMissionDependencies, type SocReportInput } from './missions/soc.js';
import { StaticSocSourceAdapter, parseSocPreparedSnapshot } from './soc-source.js';
import type { SocRedactionTrustStore } from './soc-redaction.js';

/** The host configures trust; a request cannot supply its own signing key. */
export function redactionTrustFromEnv(env: NodeJS.ProcessEnv = process.env): SocRedactionTrustStore {
  const issuer = env.SOC_REDACTION_ISSUER;
  const keyId = env.SOC_REDACTION_KEY_ID;
  const keyPath = env.SOC_REDACTION_PUBLIC_KEY_FILE;
  if (!issuer || !keyId || !keyPath) {
    throw new Error('SOC_REDACTION_ISSUER, SOC_REDACTION_KEY_ID, SOC_REDACTION_PUBLIC_KEY_FILE are required for v1 missions');
  }
  const publicKey = createPublicKey(readFileSync(keyPath));
  return { resolve: (candidateIssuer, candidateKey) => candidateIssuer === issuer && candidateKey === keyId ? publicKey : undefined };
}

/** Run either v1 mission using a verified snapshot and the existing host workflow. */
export async function executeSocSnapshot(
  value: unknown,
  authorization: SocAuthorizationContext,
  options: Omit<SocReportInput, 'authorization' | 'snapshot'>,
  dependencies: SocMissionDependencies,
) {
  const candidate = SocPreparedSnapshotSchema.parse(value);
  const snapshot = parseSocPreparedSnapshot(candidate, {
    mission: candidate.mission,
    authorization,
  }, dependencies.redactionTrust);
  if (snapshot.mission === 'report') {
    return socReport({ ...options, authorization, snapshot }, dependencies);
  }
  const { snapshotSha256: _hash, ...unsigned } = snapshot;
  const subjects = [...new Map(snapshot.queryReceipts.map(({ subject }) => [JSON.stringify(subject), subject])).values()];
  return socInvestigation({
    ...options,
    authorization,
    subjects,
    timeFrom: snapshot.timeFrom,
    timeTo: snapshot.timeTo,
    providerSchema: snapshot.providerSchema,
  }, new StaticSocSourceAdapter(unsigned), dependencies);
}
