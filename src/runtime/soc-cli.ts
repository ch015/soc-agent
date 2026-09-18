import { z } from 'zod';

import {
  SocAuthorizationContextSchema,
  SocMissionSchema,
  type SocMission,
  type SocPreparedSnapshot,
} from './contracts/soc-schemas.js';
import { loadSocPreparedSnapshot } from './soc-source.js';
import type { SocRedactionTrustStore } from './soc-redaction.js';

export const SocSnapshotCliRequestSchema = z.object({
  path: z.string().min(1),
  mission: SocMissionSchema,
  authorization: SocAuthorizationContextSchema,
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(50),
  maxRows: z.number().int().min(1).max(2_000).default(2_000),
  rateLimitPerMinute: z.number().int().min(1).max(1_000).default(1),
}).strict();

export type SocSnapshotCliRequest = z.input<typeof SocSnapshotCliRequestSchema> & {
  redactionTrust: SocRedactionTrustStore;
};

export type SocSnapshotCliPage = {
  schema: SocPreparedSnapshot['schema'];
  snapshotId: string;
  snapshotSha256: string;
  mission: SocMission;
  tenantId: string;
  actorId: string;
  timeFrom: string;
  timeTo: string;
  providerSchema: SocPreparedSnapshot['providerSchema'];
  classification: SocPreparedSnapshot['classification'];
  redactionReceipt: SocPreparedSnapshot['redactionReceipt'];
  coverage: SocPreparedSnapshot['coverage'];
  queryReceipts: SocPreparedSnapshot['queryReceipts'];
  aggregates: SocPreparedSnapshot['aggregates'];
  page: number;
  pageSize: number;
  totalRecords: number;
  totalPages: number;
  records: SocPreparedSnapshot['records'];
  requestsConsumed: 1;
  rateLimitPerMinute: number;
};

export function readSocPreparedSnapshotPage(input: SocSnapshotCliRequest): SocSnapshotCliPage {
  const { redactionTrust, ...untrustedRequest } = input;
  const request = SocSnapshotCliRequestSchema.parse(untrustedRequest);
  const snapshot = loadSocPreparedSnapshot({
    path: request.path,
    mission: request.mission,
    authorization: request.authorization,
    redactionTrust,
  });
  if (snapshot.records.length > request.maxRows) {
    throw new Error(`SOC snapshot record 수가 maxRows를 초과했다: ${snapshot.records.length} > ${request.maxRows}`);
  }
  const start = (request.page - 1) * request.pageSize;
  const records = snapshot.records.slice(start, start + request.pageSize);
  return {
    schema: snapshot.schema,
    snapshotId: snapshot.snapshotId,
    snapshotSha256: snapshot.snapshotSha256,
    mission: snapshot.mission,
    tenantId: snapshot.tenantId,
    actorId: snapshot.actorId,
    timeFrom: snapshot.timeFrom,
    timeTo: snapshot.timeTo,
    providerSchema: snapshot.providerSchema,
    classification: snapshot.classification,
    redactionReceipt: snapshot.redactionReceipt,
    coverage: snapshot.coverage,
    queryReceipts: snapshot.queryReceipts,
    aggregates: snapshot.aggregates,
    page: request.page,
    pageSize: request.pageSize,
    totalRecords: snapshot.records.length,
    totalPages: Math.max(1, Math.ceil(snapshot.records.length / request.pageSize)),
    records,
    requestsConsumed: 1,
    rateLimitPerMinute: request.rateLimitPerMinute,
  };
}
