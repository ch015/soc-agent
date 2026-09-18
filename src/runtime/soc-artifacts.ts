import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  SocInvestigationAnalysisPayloadSchema,
  SocInvestigationEvidenceReviewPayloadSchema,
  SocInvestigationVerificationPayloadSchema,
  SocReportEvidenceReviewPayloadSchema,
  SocReportJudgmentPayloadSchema,
  SocReportVerificationPayloadSchema,
  type SocAdvisoryAction,
  type SocClaim,
  type SocHypothesis,
  type SocMission,
  type SocPreparedSnapshot,
} from './contracts/soc-schemas.js';
import type { QualityIssueCollector } from './quality-issues.js';
import { renderSocInvestigationDraft, renderSocReportDraft } from './soc-rendering.js';
import { assertSocContextSafeString, verifySocPreparedSnapshotIntegrity } from './soc-source.js';

export type SocPhaseResult = {
  artifacts: string[];
  status: 'complete';
  unresolved: string[];
  gateDecision?: 'pass' | 'hold';
  claimCount: number;
};

const FORBIDDEN_ASSERTION = /(?:confirmed\s+(?:compromise|breach|attribution)|definitely\s+malicious|is\s+the\s+attacker|(?:we\s+)?(?:blocked|quarantined)\s+(?:the\s+)?(?:ip|user|host)|case\s+(?:was\s+)?created|notification\s+(?:was\s+)?sent|침해가\s*확정|공격자로\s*확정|악성임이\s*확정|(?:ip|사용자|호스트).{0,12}차단\s*(?:했다|완료)|케이스\s*(?:생성|등록)\s*완료|알림\s*(?:발송|전송)\s*완료|조치\s*완료|법적\s*준수|규제\s*준수\s*확정)/iu;

export function materializeSocPhase(input: {
  mission: SocMission;
  phase: string;
  value: unknown;
  engagementDir: string;
  collector?: QualityIssueCollector;
}): SocPhaseResult {
  const snapshot = loadSnapshot(input.engagementDir, input.mission);
  if (input.mission === 'report') return materializeReport(input, snapshot);
  return materializeInvestigation(input, snapshot);
}

function materializeReport(
  input: { phase: string; value: unknown; engagementDir: string; collector?: QualityIssueCollector },
  snapshot: SocPreparedSnapshot,
): SocPhaseResult {
  if (input.phase === 'evidence-review') {
    const payload = SocReportEvidenceReviewPayloadSchema.parse(input.value);
    assertComplete(payload);
    assertSnapshotIdentity(payload, snapshot);
    const expectedLocators = snapshotLocators(snapshot);
    assertExactSet(payload.availableLocators, expectedLocators, 'SOC report evidence locator');
    assertKnownLocators(payload.counterEvidenceLocators, expectedLocators);
    const expectedCoverage = snapshot.coverage.complete ? 'complete' : 'partial';
    if (payload.coverageAssessment !== expectedCoverage) {
      const msg = 'SOC report coverage assessment가 snapshot과 다르다';
      if (input.collector) {
        input.collector.record({ domain: 'soc', type: 'coverage-mismatch', phase: input.phase, severity: 'error', detail: msg });
      } else {
        throw new Error(msg);
      }
    }
    assertNoForbiddenAssertions([
      payload.summary,
      ...payload.limitations,
      ...payload.biasRisks,
      ...payload.unresolved,
    ]);
    writeJson(input.engagementDir, '02_soc_report_evidence_review.json', payload);
    return result(['02_soc_report_evidence_review.json'], payload.unresolved, 0);
  }

  if (input.phase === 'judge') {
    const payload = SocReportJudgmentPayloadSchema.parse(input.value);
    assertComplete(payload);
    assertSnapshotIdentity(payload, snapshot);
    assertClaims(payload.claims, snapshot);
    assertUnique(payload.claims.map((claim) => claim.claimKey), 'SOC report claimKey');
    assertUnique(payload.advisoryActions.map((action) => action.actionKey), 'SOC report actionKey');
    assertNoForbiddenAssertions([
      ...textsForClaims(payload.claims),
      ...payload.dataQuality,
      ...payload.advisoryActions.flatMap((action) => [action.subject, action.rationale]),
      ...payload.unresolved,
    ]);
    for (const action of payload.advisoryActions) {
      assertKnownLocators(action.evidenceLocators, snapshotLocators(snapshot));
    }
    writeJson(input.engagementDir, '03_soc_report_judgment.json', payload);
    return result(['03_soc_report_judgment.json'], payload.unresolved, payload.claims.length);
  }

  if (input.phase === 'verify') {
    const payload = SocReportVerificationPayloadSchema.parse(input.value);
    assertComplete(payload);
    assertSnapshotIdentity(payload, snapshot);
    const judgment = SocReportJudgmentPayloadSchema.parse(readJson(input.engagementDir, '03_soc_report_judgment.json'));
    assertComplete(judgment);
    assertExactReviews(payload.claimReviews, judgment.claims, snapshot);
    assertExactActionReviews(payload.actionReviews, judgment.advisoryActions, snapshot);
    const evidenceReview = SocReportEvidenceReviewPayloadSchema.parse(
      readJson(input.engagementDir, '02_soc_report_evidence_review.json'),
    );
    assertComplete(evidenceReview);
    assertNoForbiddenAssertions([
      payload.summary,
      ...payload.claimReviews.flatMap((review) => [review.reason]),
      ...payload.actionReviews.flatMap((review) => [review.reason]),
      ...payload.unresolved,
    ]);
    assertVerificationDecision({
      gateDecision: payload.gateDecision,
      reviews: payload.claimReviews,
      actionReviews: payload.actionReviews,
      checks: [
        payload.anchoringChecked,
        payload.counterEvidenceChecked,
        payload.alternativesChecked,
        payload.coverageQualified,
      ],
      coverageComplete: snapshot.coverage.complete,
      unresolved: [...evidenceReview.unresolved, ...judgment.unresolved, ...payload.unresolved],
      collector: input.collector,
      phase: input.phase,
    });
    const jsonName = '04_soc_report_verification.json';
    const draftName = '05_soc_report_draft.md';
    writeJson(input.engagementDir, jsonName, payload);
    writeText(input.engagementDir, draftName, renderSocReportDraft(snapshot, evidenceReview, judgment, {
      ...payload,
      unresolved: [...evidenceReview.unresolved, ...judgment.unresolved, ...payload.unresolved],
    }));
    return result([jsonName, draftName], payload.unresolved, judgment.claims.length, payload.gateDecision);
  }

  throw new Error(`알 수 없는 SOC report phase: ${input.phase}`);
}

function materializeInvestigation(
  input: { phase: string; value: unknown; engagementDir: string; collector?: QualityIssueCollector },
  snapshot: SocPreparedSnapshot,
): SocPhaseResult {
  if (input.phase === 'evidence-review') {
    const payload = SocInvestigationEvidenceReviewPayloadSchema.parse(input.value);
    assertComplete(payload);
    assertSnapshotIdentity(payload, snapshot);
    assertExactSet(payload.availableLocators, snapshotLocators(snapshot), 'SOC investigation evidence locator');
    assertExactSet(
      payload.reviewedQueryIds,
      snapshot.queryReceipts.map((receipt) => receipt.queryId),
      'SOC investigation query review',
    );
    const expectedCoverage = snapshot.coverage.complete ? 'complete' : 'partial';
    if (payload.coverageAssessment !== expectedCoverage) {
      const msg = 'SOC investigation coverage assessment가 snapshot과 다르다';
      if (input.collector) {
        input.collector.record({ domain: 'soc', type: 'coverage-mismatch', phase: input.phase, severity: 'error', detail: msg });
      } else {
        throw new Error(msg);
      }
    }
    const expectedDirections = missingIpDirections(snapshot);
    assertExactSet(payload.missingDirections, expectedDirections, 'SOC investigation missing direction');
    assertNoForbiddenAssertions([
      payload.summary,
      ...payload.limitations,
      ...payload.biasRisks,
      ...payload.unresolved,
    ]);
    writeJson(input.engagementDir, '02_soc_investigation_evidence_review.json', payload);
    return result(['02_soc_investigation_evidence_review.json'], payload.unresolved, 0);
  }

  if (input.phase === 'analyze') {
    const payload = SocInvestigationAnalysisPayloadSchema.parse(input.value);
    assertComplete(payload);
    assertSnapshotIdentity(payload, snapshot);
    assertClaims(payload.claims, snapshot);
    assertUnique(payload.claims.map((claim) => claim.claimKey), 'SOC investigation claimKey');
    assertUnique(payload.advisoryActions.map((action) => action.actionKey), 'SOC investigation actionKey');
    assertUnique(payload.hypotheses.map((hypothesis) => hypothesis.hypothesisKey), 'SOC investigation hypothesisKey');
    const locators = snapshotLocators(snapshot);
    for (const hypothesis of payload.hypotheses) {
      assertKnownLocators(hypothesis.evidenceLocators, locators);
      assertKnownLocators(hypothesis.counterEvidenceLocators, locators);
    }
    for (const action of payload.advisoryActions) assertKnownLocators(action.evidenceLocators, locators);
    assertNoForbiddenAssertions([
      ...textsForClaims(payload.claims),
      ...payload.hypotheses.flatMap((hypothesis) => [
        hypothesis.statement,
        ...hypothesis.prerequisites,
        ...hypothesis.limitations,
      ]),
      ...payload.advisoryActions.flatMap((action) => [action.subject, action.rationale]),
      ...payload.unresolved,
    ]);
    writeJson(input.engagementDir, '03_soc_investigation_analysis.json', payload);
    return result(['03_soc_investigation_analysis.json'], payload.unresolved, payload.claims.length);
  }

  if (input.phase === 'verify') {
    const payload = SocInvestigationVerificationPayloadSchema.parse(input.value);
    assertComplete(payload);
    assertSnapshotIdentity(payload, snapshot);
    const analysis = SocInvestigationAnalysisPayloadSchema.parse(
      readJson(input.engagementDir, '03_soc_investigation_analysis.json'),
    );
    assertComplete(analysis);
    assertExactReviews(payload.claimReviews, analysis.claims, snapshot);
    assertExactActionReviews(payload.actionReviews, analysis.advisoryActions, snapshot);
    assertExactHypothesisReviews(payload.hypothesisReviews, analysis.hypotheses, snapshot);
    const evidenceReview = SocInvestigationEvidenceReviewPayloadSchema.parse(
      readJson(input.engagementDir, '02_soc_investigation_evidence_review.json'),
    );
    assertComplete(evidenceReview);
    assertNoForbiddenAssertions([
      payload.summary,
      ...payload.claimReviews.flatMap((review) => [review.reason]),
      ...payload.actionReviews.flatMap((review) => [review.reason]),
      ...payload.hypothesisReviews.flatMap((review) => [review.reason]),
      ...payload.unresolved,
    ]);
    assertVerificationDecision({
      gateDecision: payload.gateDecision,
      reviews: payload.claimReviews,
      actionReviews: payload.actionReviews,
      hypothesisReviews: payload.hypothesisReviews,
      checks: [
        payload.queryCoverageChecked,
        payload.anchoringChecked,
        payload.counterEvidenceChecked,
        payload.alternativesChecked,
      ],
      coverageComplete: snapshot.coverage.complete && missingIpDirections(snapshot).length === 0,
      unresolved: [...evidenceReview.unresolved, ...analysis.unresolved, ...payload.unresolved],
      collector: input.collector,
      phase: input.phase,
    });
    const jsonName = '04_soc_investigation_verification.json';
    const draftName = '05_soc_investigation_draft.md';
    writeJson(input.engagementDir, jsonName, payload);
    writeText(input.engagementDir, draftName, renderSocInvestigationDraft(snapshot, evidenceReview, analysis, {
      ...payload,
      unresolved: [...evidenceReview.unresolved, ...analysis.unresolved, ...payload.unresolved],
    }));
    return result([jsonName, draftName], payload.unresolved, analysis.claims.length, payload.gateDecision);
  }

  throw new Error(`알 수 없는 SOC investigation phase: ${input.phase}`);
}

function assertComplete<T extends { status: string; unresolved: string[] }>(
  payload: T,
): asserts payload is T & { status: 'complete' } {
  if (payload.status !== 'complete') {
    throw new Error(`SOC phase가 blocked 상태다: ${payload.unresolved.join(', ')}`);
  }
}

function assertSnapshotIdentity(
  payload: { snapshotId: string; snapshotSha256: string },
  snapshot: SocPreparedSnapshot,
): void {
  if (payload.snapshotId !== snapshot.snapshotId || payload.snapshotSha256 !== snapshot.snapshotSha256) {
    throw new Error('SOC result snapshot identity가 다르다');
  }
}

function assertClaims(claims: readonly SocClaim[], snapshot: SocPreparedSnapshot): void {
  const locators = snapshotLocators(snapshot);
  for (const claim of claims) {
    assertKnownLocators(claim.evidenceLocators, locators);
    assertUnique(claim.evidenceLocators, `SOC evidence locator ${claim.claimKey}`);
    assertKnownLocators(claim.counterEvidenceLocators, locators);
    if (claim.epistemicStatus === 'observed' && !claim.evidenceLocators.some((locator) => locator.startsWith('rec-'))) {
      throw new Error(`SOC observed claim에는 record locator가 필요하다: ${claim.claimKey}`);
    }
    assertExactSet(
      [...new Set(claim.evidenceAssertions.map((assertion) => assertion.locator))],
      claim.evidenceLocators,
      `SOC evidence assertion ${claim.claimKey}`,
    );
    assertUnique(
      claim.evidenceAssertions.map((assertion) => JSON.stringify(assertion)),
      `SOC evidence assertion tuple ${claim.claimKey}`,
    );
    for (const assertion of claim.evidenceAssertions) assertEvidenceAssertion(assertion, snapshot);
  }
}

function assertEvidenceAssertion(
  assertion: SocClaim['evidenceAssertions'][number],
  snapshot: SocPreparedSnapshot,
): void {
  const record = snapshot.records.find((candidate) => candidate.locator === assertion.locator);
  const aggregate = snapshot.aggregates.find((candidate) => candidate.locator === assertion.locator);
  let observed: unknown;
  if (record) {
    if (assertion.field === 'kind') observed = record.kind;
    else if (assertion.field === 'timestamp') observed = record.timestamp;
    else if (assertion.field === 'entityRefs') observed = record.entityRefs;
    else if (assertion.field.startsWith('facts.')) observed = record.facts[assertion.field.slice('facts.'.length)];
    else throw new Error(`SOC record assertion field가 유효하지 않다: ${assertion.field}`);
  } else if (aggregate) {
    if (assertion.field === 'metric') observed = aggregate.metric;
    else if (assertion.field === 'value') observed = aggregate.value;
    else if (assertion.field.startsWith('dimensions.')) observed = aggregate.dimensions[assertion.field.slice('dimensions.'.length)];
    else throw new Error(`SOC aggregate assertion field가 유효하지 않다: ${assertion.field}`);
  } else {
    throw new Error(`SOC evidence assertion locator가 없다: ${assertion.locator}`);
  }
  if (assertion.operator === 'contains') {
    if (!Array.isArray(observed) || typeof assertion.expected !== 'string' || !observed.includes(assertion.expected)) {
      throw new Error(`SOC evidence contains assertion이 snapshot과 다르다: ${assertion.locator}/${assertion.field}`);
    }
  } else if (!Object.is(observed, assertion.expected)) {
    throw new Error(`SOC evidence equals assertion이 snapshot과 다르다: ${assertion.locator}/${assertion.field}`);
  }
}

function assertExactReviews(
  reviews: ReadonlyArray<{ claimKey: string; evidenceLocators: string[] }>,
  claims: readonly SocClaim[],
  snapshot: SocPreparedSnapshot,
): void {
  assertExactSet(reviews.map((review) => review.claimKey), claims.map((claim) => claim.claimKey), 'SOC claim review');
  assertUnique(reviews.map((review) => review.claimKey), 'SOC claim review');
  const byKey = new Map(claims.map((claim) => [claim.claimKey, claim]));
  for (const review of reviews) {
    assertKnownLocators(review.evidenceLocators, snapshotLocators(snapshot));
    const claim = byKey.get(review.claimKey);
    if (!claim) throw new Error(`SOC review claim이 없다: ${review.claimKey}`);
    assertExactSet(review.evidenceLocators, claim.evidenceLocators, `SOC review evidence ${review.claimKey}`);
  }
}

function assertExactActionReviews(
  reviews: ReadonlyArray<{ actionKey: string; evidenceLocators: string[] }>,
  actions: readonly SocAdvisoryAction[],
  snapshot: SocPreparedSnapshot,
): void {
  assertExactSet(reviews.map((review) => review.actionKey), actions.map((action) => action.actionKey), 'SOC action review');
  assertUnique(reviews.map((review) => review.actionKey), 'SOC action review');
  const byKey = new Map(actions.map((action) => [action.actionKey, action]));
  for (const review of reviews) {
    assertKnownLocators(review.evidenceLocators, snapshotLocators(snapshot));
    const action = byKey.get(review.actionKey);
    if (!action) throw new Error(`SOC review action이 없다: ${review.actionKey}`);
    assertExactSet(review.evidenceLocators, action.evidenceLocators, `SOC review action evidence ${review.actionKey}`);
  }
}

function assertExactHypothesisReviews(
  reviews: ReadonlyArray<{
    hypothesisKey: string;
    evidenceLocators: string[];
    counterEvidenceLocators: string[];
  }>,
  hypotheses: readonly SocHypothesis[],
  snapshot: SocPreparedSnapshot,
): void {
  assertExactSet(reviews.map((review) => review.hypothesisKey), hypotheses.map((item) => item.hypothesisKey), 'SOC hypothesis review');
  const byKey = new Map(hypotheses.map((hypothesis) => [hypothesis.hypothesisKey, hypothesis]));
  for (const review of reviews) {
    const hypothesis = byKey.get(review.hypothesisKey);
    if (!hypothesis) throw new Error(`SOC review hypothesis가 없다: ${review.hypothesisKey}`);
    assertKnownLocators([...review.evidenceLocators, ...review.counterEvidenceLocators], snapshotLocators(snapshot));
    assertExactSet(review.evidenceLocators, hypothesis.evidenceLocators, `SOC hypothesis evidence ${review.hypothesisKey}`);
    assertExactSet(review.counterEvidenceLocators, hypothesis.counterEvidenceLocators, `SOC hypothesis counterevidence ${review.hypothesisKey}`);
  }
}

function assertVerificationDecision(input: {
  gateDecision: 'pass' | 'hold';
  reviews: ReadonlyArray<{ decision: 'supported' | 'unsupported' | 'uncertain' }>;
  actionReviews: ReadonlyArray<{ decision: 'proportionate' | 'unsupported' | 'uncertain' }>;
  hypothesisReviews?: ReadonlyArray<{ decision: 'reconciled' | 'unsupported' | 'uncertain' }>;
  checks: readonly boolean[];
  coverageComplete: boolean;
  unresolved: readonly string[];
  collector?: QualityIssueCollector;
  phase?: string;
}): void {
  const deterministicPass =
    input.coverageComplete &&
    input.checks.every(Boolean) &&
    input.reviews.every((review) => review.decision === 'supported') &&
    input.actionReviews.every((review) => review.decision === 'proportionate') &&
    (input.hypothesisReviews ?? []).every((review) => review.decision === 'reconciled') &&
    input.unresolved.length === 0;
  if (input.gateDecision === 'pass' && !deterministicPass) {
    const msg = 'SOC verifier pass가 deterministic gate와 모순된다';
    if (input.collector) {
      input.collector.record({ domain: 'soc', type: 'gate-decision-mismatch', phase: input.phase ?? 'verify', severity: 'error', detail: msg });
    } else {
      throw new Error(msg);
    }
  }
}

function loadSnapshot(engagementDir: string, mission: SocMission): SocPreparedSnapshot {
  const name = mission === 'report' ? '01_soc_report_snapshot.json' : '01_soc_investigation_snapshot.json';
  return verifySocPreparedSnapshotIntegrity(readJson(engagementDir, name), mission);
}

function snapshotLocators(snapshot: SocPreparedSnapshot): string[] {
  return [
    ...snapshot.records.map((record) => record.locator),
    ...snapshot.aggregates.map((aggregate) => aggregate.locator),
  ].sort();
}

function missingIpDirections(snapshot: SocPreparedSnapshot): Array<'source' | 'destination'> {
  const ipReceipts = snapshot.queryReceipts.filter((receipt) => receipt.subject.type === 'ip');
  if (ipReceipts.length === 0) return [];
  const missing: Array<'source' | 'destination'> = [];
  if (!ipReceipts.some((receipt) => receipt.operation === 'event-search-source')) missing.push('source');
  if (!ipReceipts.some((receipt) => receipt.operation === 'event-search-destination')) missing.push('destination');
  return missing;
}

function assertKnownLocators(values: readonly string[], knownValues: readonly string[]): void {
  const known = new Set(knownValues);
  for (const value of values) {
    if (!known.has(value)) throw new Error(`SOC evidence locator가 snapshot에 없다: ${value}`);
  }
}

function assertExactSet(actual: readonly string[], expected: readonly string[], label: string): void {
  assertUnique(actual, label);
  if (actual.length !== expected.length || actual.some((value) => !expected.includes(value))) {
    throw new Error(`${label} 집합이 host evidence와 다르다`);
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label}가 중복됐다`);
}

function assertNoForbiddenAssertions(values: readonly string[]): void {
  for (const value of values) assertSocContextSafeString(value, 'model phase output');
  if (values.some((value) => FORBIDDEN_ASSERTION.test(value))) {
    throw new Error('SOC 결과에 계약 밖 확정·준수 주장이 있다');
  }
}

function textsForClaims(claims: readonly SocClaim[]): string[] {
  return claims.flatMap((claim) => [
    claim.statement,
    ...claim.alternativeExplanations,
    ...claim.limitations,
    ...claim.evidenceAssertions.flatMap((assertion) =>
      typeof assertion.expected === 'string' ? [assertion.expected] : []),
  ]);
}

function result(
  artifacts: string[],
  unresolved: string[],
  claimCount: number,
  gateDecision?: 'pass' | 'hold',
): SocPhaseResult {
  return {
    artifacts,
    status: 'complete',
    unresolved: [...unresolved],
    claimCount,
    ...(gateDecision ? { gateDecision } : {}),
  };
}

function readJson(engagementDir: string, name: string): unknown {
  return JSON.parse(readFileSync(join(resolve(engagementDir), name), 'utf8')) as unknown;
}

function writeJson(engagementDir: string, name: string, value: unknown): void {
  writeFileSync(join(resolve(engagementDir), name), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

function writeText(engagementDir: string, name: string, value: string): void {
  writeFileSync(join(resolve(engagementDir), name), value, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}
