import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  SocAuthorizationContextSchema,
  SocPreparedSnapshotSchema,
  SocPreparedSnapshotUnsignedSchema,
  SocQueryPlanSchema,
  SocSubjectSchema,
  type SocAuthorizationContext,
  type SocMission,
  type SocPreparedSnapshot,
  type SocPreparedSnapshotUnsigned,
  type SocQueryPlan,
} from './contracts/soc-schemas.js';
import { verifySocRedactionAttestation, type SocRedactionTrustStore } from './soc-redaction.js';

const MAX_SNAPSHOT_BYTES = 1_000_000;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;
const INSTRUCTION_LIKE = /(?:ignore\s+(?:all\s+)?(?:previous|prior)|system\s+prompt|developer\s+message|follow\s+these\s+instructions|이전\s*(?:지시|명령).*무시|시스템\s*프롬프트|지시를\s*따라)/iu;
const SECRET_LIKE = /(?:AKIA[0-9A-Z]{16}|\bsk-[A-Za-z0-9_-]{20,}|bearer\s+[A-Za-z0-9._~+/=-]{16,}|(?:api[_-]?key|password|secret)\s*[:=]\s*[^\s]{8,})/iu;

export interface SocSourceAdapter {
  readonly name: string;
  collect(plan: SocQueryPlan, authorization: SocAuthorizationContext): Promise<SocPreparedSnapshotUnsigned>;
}

export class StaticSocSourceAdapter implements SocSourceAdapter {
  readonly name = 'static-soc-source';

  constructor(private readonly snapshot: SocPreparedSnapshotUnsigned) {}

  async collect(plan: SocQueryPlan, authorization: SocAuthorizationContext): Promise<SocPreparedSnapshotUnsigned> {
    assertSocAuthorization(authorization, plan.mission);
    assertSnapshotMatchesPlan(this.snapshot, plan);
    return structuredClone(this.snapshot);
  }
}

export function assertSocAuthorization(
  value: SocAuthorizationContext,
  mission: SocMission,
): SocAuthorizationContext {
  const authorization = SocAuthorizationContextSchema.parse(value);
  const required = mission === 'report' ? 'soc:report:read' : 'soc:investigation:read';
  if (!authorization.scopes.includes(required)) {
    throw new Error(`SOC ${mission} scope가 없다: ${required}`);
  }
  return authorization;
}

export function compileSocInvestigationQueryPlan(input: {
  authorization: SocAuthorizationContext;
  subjects: Array<{ type: 'ip' | 'user' | 'host' | 'signal' | 'case'; value: string }>;
  timeFrom: string;
  timeTo: string;
  providerSchema: { name: string; version: string; adapterVersion: string };
  maxPages?: number;
  maxRows?: number;
}): SocQueryPlan {
  const authorization = assertSocAuthorization(input.authorization, 'investigation');
  const subjects = input.subjects.map((subject) => SocSubjectSchema.parse(subject));
  if (subjects.length === 0 || subjects.length > 10) {
    throw new Error('SOC investigation subject는 1~10개여야 한다');
  }
  assertUtcWindow(input.timeFrom, input.timeTo);
  const maxPages = input.maxPages ?? 20;
  const maxRows = input.maxRows ?? 2_000;
  const queries: SocQueryPlan['queries'] = [];
  const append = (operation: SocQueryPlan['queries'][number]['operation'], subject: (typeof subjects)[number]) => {
    queries.push({
      queryId: `qry-${String(queries.length + 1).padStart(2, '0')}-${operation}`,
      operation,
      subject,
      timeFrom: input.timeFrom,
      timeTo: input.timeTo,
      maxPages,
      maxRows,
    });
  };
  for (const subject of subjects) {
    if (subject.type === 'ip') {
      append('event-search-source', subject);
      append('event-search-destination', subject);
      append('entity-summary', subject);
    } else if (subject.type === 'case') {
      append('case-search', subject);
      append('entity-summary', subject);
    } else if (subject.type === 'signal') {
      append('signal-search', subject);
      append('entity-summary', subject);
    } else {
      append('event-search-source', subject);
      append('entity-summary', subject);
    }
  }
  return SocQueryPlanSchema.parse({
    mission: 'investigation',
    tenantId: authorization.tenantId,
    actorId: authorization.actorId,
    timeFrom: input.timeFrom,
    timeTo: input.timeTo,
    timezone: 'UTC',
    windowSemantics: 'half-open',
    providerSchema: input.providerSchema,
    queries,
  });
}

export function createSocPreparedSnapshot(
  input: SocPreparedSnapshotUnsigned,
  trust: SocRedactionTrustStore,
): SocPreparedSnapshot {
  const unsigned = SocPreparedSnapshotUnsignedSchema.parse(input);
  verifySocRedactionAttestation(unsigned, trust);
  validateSocSnapshotContent(unsigned);
  return SocPreparedSnapshotSchema.parse({
    ...unsigned,
    snapshotSha256: hashCanonical(unsigned),
  });
}

export function parseSocPreparedSnapshot(
  value: unknown,
  expected: { mission: SocMission; authorization: SocAuthorizationContext },
  redactionTrust?: SocRedactionTrustStore,
): SocPreparedSnapshot {
  const snapshot = SocPreparedSnapshotSchema.parse(value);
  const authorization = assertSocAuthorization(expected.authorization, expected.mission);
  if (snapshot.mission !== expected.mission) throw new Error('SOC snapshot mission이 다르다');
  if (snapshot.tenantId !== authorization.tenantId || snapshot.actorId !== authorization.actorId) {
    throw new Error('SOC snapshot tenant/actor가 authorization과 다르다');
  }
  const { snapshotSha256, ...unsigned } = snapshot;
  if (snapshotSha256 !== hashCanonical(unsigned)) throw new Error('SOC snapshot hash가 다르다');
  if (redactionTrust) verifySocRedactionAttestation(unsigned, redactionTrust);
  validateSocSnapshotContent(unsigned);
  return snapshot;
}

export function verifySocPreparedSnapshotIntegrity(
  value: unknown,
  mission: SocMission,
): SocPreparedSnapshot {
  const candidate = SocPreparedSnapshotSchema.parse(value);
  return parseSocPreparedSnapshot(candidate, {
    mission,
    authorization: {
      tenantId: candidate.tenantId,
      actorId: candidate.actorId,
      scopes: [mission === 'report' ? 'soc:report:read' : 'soc:investigation:read'],
    },
  });
}

export function materializeSocPreparedSnapshot(input: {
  value: SocPreparedSnapshot | SocPreparedSnapshotUnsigned;
  mission: SocMission;
  authorization: SocAuthorizationContext;
  engagementDir: string;
  redactionTrust: SocRedactionTrustStore;
}): { snapshot: SocPreparedSnapshot; path: string; bytes: number } {
  const candidate = 'snapshotSha256' in input.value
    ? parseSocPreparedSnapshot(input.value, input)
    : parseSocPreparedSnapshot(createSocPreparedSnapshot(input.value, input.redactionTrust), input);
  const { snapshotSha256: _snapshotSha256, ...unsigned } = candidate;
  verifySocRedactionAttestation(unsigned, input.redactionTrust);
  const name = input.mission === 'report'
    ? '01_soc_report_snapshot.json'
    : '01_soc_investigation_snapshot.json';
  const path = join(resolve(input.engagementDir), name);
  if (dirname(path) !== resolve(input.engagementDir) || basename(path) !== name) {
    throw new Error('SOC snapshot artifact 경로가 engagement 밖이다');
  }
  const content = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8');
  if (content.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('SOC snapshot 크기 제한을 초과했다');
  writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
  return { snapshot: candidate, path, bytes: content.byteLength };
}

export function loadSocPreparedSnapshot(input: {
  path: string;
  mission: SocMission;
  authorization: SocAuthorizationContext;
  redactionTrust: SocRedactionTrustStore;
}): SocPreparedSnapshot {
  if (!isAbsolute(input.path) || !existsSync(input.path) || !statSync(input.path).isFile()) {
    throw new Error(`SOC snapshot 파일이 없다: ${input.path}`);
  }
  const content = readFileSync(input.path);
  if (content.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('SOC snapshot 크기 제한을 초과했다');
  return parseSocPreparedSnapshot(JSON.parse(content.toString('utf8')), input, input.redactionTrust);
}

export function assertSnapshotMatchesPlan(
  snapshotInput: SocPreparedSnapshotUnsigned,
  planInput: SocQueryPlan,
): void {
  const snapshot = SocPreparedSnapshotUnsignedSchema.parse(snapshotInput);
  const plan = SocQueryPlanSchema.parse(planInput);
  if (
    snapshot.mission !== plan.mission ||
    snapshot.tenantId !== plan.tenantId ||
    snapshot.actorId !== plan.actorId ||
    snapshot.timeFrom !== plan.timeFrom ||
    snapshot.timeTo !== plan.timeTo ||
    snapshot.timezone !== plan.timezone ||
    snapshot.windowSemantics !== plan.windowSemantics ||
    JSON.stringify(snapshot.providerSchema) !== JSON.stringify(plan.providerSchema)
  ) {
    throw new Error('SOC snapshot과 query plan identity가 다르다');
  }
  const byId = new Map(snapshot.queryReceipts.map((receipt) => [receipt.queryId, receipt]));
  if (byId.size !== snapshot.queryReceipts.length || byId.size !== plan.queries.length) {
    throw new Error('SOC query receipt 집합이 plan과 다르다');
  }
  for (const query of plan.queries) {
    const receipt = byId.get(query.queryId);
    if (!receipt) throw new Error(`SOC query receipt가 없다: ${query.queryId}`);
    if (
      receipt.operation !== query.operation ||
      JSON.stringify(receipt.subject) !== JSON.stringify(query.subject) ||
      receipt.tenantId !== plan.tenantId ||
      receipt.actorId !== plan.actorId ||
      receipt.timeFrom !== query.timeFrom ||
      receipt.timeTo !== query.timeTo ||
      receipt.pages > query.maxPages ||
      receipt.rows > query.maxRows
    ) {
      throw new Error(`SOC query receipt가 plan 범위를 벗어났다: ${query.queryId}`);
    }
  }
  if (snapshot.coverage.complete && snapshot.queryReceipts.some((receipt) => !receipt.cursorExhausted)) {
    throw new Error('SOC complete coverage에 미완료 cursor가 있다');
  }
}

function validateSocSnapshotContent(snapshot: SocPreparedSnapshotUnsigned): void {
  assertUtcWindow(snapshot.timeFrom, snapshot.timeTo);
  if (snapshot.classification === 'restricted') {
    throw new Error('restricted SOC snapshot은 모델 컨텍스트에 넣을 수 없다');
  }
  assertSocContextSafeString(snapshot.providerSchema.name, 'provider schema name');
  assertSocContextSafeString(snapshot.providerSchema.version, 'provider schema version');
  assertSocContextSafeString(snapshot.providerSchema.adapterVersion, 'provider adapter version');
  const queryIds = snapshot.queryReceipts.map((receipt) => receipt.queryId);
  if (new Set(queryIds).size !== queryIds.length) throw new Error('SOC queryId가 중복됐다');
  const knownQueryIds = new Set(queryIds);
  const locators = [
    ...snapshot.records.map((record) => record.locator),
    ...snapshot.aggregates.map((aggregate) => aggregate.locator),
  ];
  if (new Set(locators).size !== locators.length) throw new Error('SOC evidence locator가 중복됐다');
  for (const receipt of snapshot.queryReceipts) {
    if (
      receipt.tenantId !== snapshot.tenantId ||
      receipt.actorId !== snapshot.actorId ||
      receipt.timeFrom !== snapshot.timeFrom ||
      receipt.timeTo !== snapshot.timeTo
    ) {
      throw new Error(`SOC query receipt scope가 snapshot과 다르다: ${receipt.queryId}`);
    }
  }
  if (snapshot.coverage.complete && snapshot.coverage.gaps.length > 0) {
    throw new Error('SOC complete coverage에 gap이 선언됐다');
  }
  if (snapshot.coverage.complete && snapshot.queryReceipts.some((receipt) => !receipt.cursorExhausted)) {
    throw new Error('SOC complete coverage에 미완료 cursor가 있다');
  }
  const from = Date.parse(snapshot.timeFrom);
  const to = Date.parse(snapshot.timeTo);
  for (const receipt of snapshot.queryReceipts) {
    assertSocContextSafeString(receipt.subject.value, `query subject ${receipt.queryId}`);
  }
  for (const gap of snapshot.coverage.gaps) assertSocContextSafeString(gap, 'coverage gap');
  for (const record of snapshot.records) {
    assertSourceQueries(record.sourceQueryIds, knownQueryIds, record.locator);
    const timestamp = Date.parse(record.timestamp);
    if (timestamp < from || timestamp >= to) throw new Error(`SOC record timestamp가 snapshot 범위 밖이다: ${record.locator}`);
    assertSocContextSafeString(record.kind, `record kind ${record.locator}`);
    for (const entity of record.entityRefs) assertSocContextSafeString(entity, `entity ${record.locator}`);
    for (const [key, value] of Object.entries(record.facts)) {
      assertSocContextSafeString(key, `fact key ${record.locator}`);
      if (typeof value === 'string') assertSocContextSafeString(value, `fact value ${record.locator}`);
    }
  }
  for (const aggregate of snapshot.aggregates) {
    assertSourceQueries(aggregate.sourceQueryIds, knownQueryIds, aggregate.locator);
    assertSocContextSafeString(aggregate.metric, `aggregate metric ${aggregate.locator}`);
    for (const [key, value] of Object.entries(aggregate.dimensions)) {
      assertSocContextSafeString(key, `aggregate dimension ${aggregate.locator}`);
      assertSocContextSafeString(value, `aggregate dimension ${aggregate.locator}`);
    }
  }
}

function assertSourceQueries(
  sourceQueryIds: readonly string[],
  knownQueryIds: ReadonlySet<string>,
  locator: string,
): void {
  if (new Set(sourceQueryIds).size !== sourceQueryIds.length) {
    throw new Error(`SOC evidence sourceQueryId가 중복됐다: ${locator}`);
  }
  for (const queryId of sourceQueryIds) {
    if (!knownQueryIds.has(queryId)) throw new Error(`SOC evidence source query가 없다: ${locator}/${queryId}`);
  }
}

export function assertSocContextSafeString(value: string, label: string): void {
  if (/[\r\n\u0000]/u.test(value) || INSTRUCTION_LIKE.test(value)) {
    throw new Error(`SOC compact evidence에 instruction-like 또는 multiline text가 있다: ${label}`);
  }
  if (SECRET_LIKE.test(value)) throw new Error(`SOC compact evidence에 secret-like value가 있다: ${label}`);
}

function assertUtcWindow(timeFrom: string, timeTo: string): void {
  if (!timeFrom.endsWith('Z') || !timeTo.endsWith('Z')) throw new Error('SOC time range는 UTC Z 형식이어야 한다');
  const from = Date.parse(timeFrom);
  const to = Date.parse(timeTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error('SOC time range가 유효하지 않다');
  if (to - from > MAX_WINDOW_MS) throw new Error('SOC time range는 31일을 초과할 수 없다');
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(`${JSON.stringify(value)}\n`).digest('hex');
}
