import { z } from 'zod';

export const SOC_CONTRACT_VERSION = '1.0.0' as const;
export const SocMissionSchema = z.enum(['report', 'investigation']);
export const SocClassificationSchema = z.enum(['public', 'internal', 'confidential', 'restricted']);
export const SocSubjectTypeSchema = z.enum(['ip', 'user', 'host', 'signal', 'case']);
export const SocQueryOperationSchema = z.enum([
  'signal-search',
  'event-search-source',
  'event-search-destination',
  'entity-summary',
  'case-search',
]);
export const SocEvidenceLocatorSchema = z.string().regex(/^(?:rec|agg)-[a-z0-9][a-z0-9._-]{1,79}$/);
export const SocSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const SocIdentifierSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/);
export const SocRedactionReceiptSchema = z.object({
  receiptId: SocIdentifierSchema,
  policyId: z.string().min(1).max(120),
  redactorVersion: z.string().min(1).max(80),
  sourcePayloadSha256: SocSha256Schema,
  projectionSha256: SocSha256Schema,
  issuer: SocIdentifierSchema,
  keyId: SocIdentifierSchema,
  issuedAt: z.string().datetime({ offset: true }),
  signatureBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
  fieldsRemoved: z.array(z.string().min(1).max(120)).max(100),
  approved: z.literal(true),
}).strict();

export const SocAuthorizationContextSchema = z.object({
  tenantId: SocIdentifierSchema,
  actorId: SocIdentifierSchema,
  scopes: z.array(z.enum(['soc:report:read', 'soc:investigation:read'])).min(1).max(2),
}).strict();

export const SocSubjectSchema = z.object({
  type: SocSubjectTypeSchema,
  value: z.string().min(1).max(320),
}).strict();

export const SocQueryPlanItemSchema = z.object({
  queryId: z.string().regex(/^qry-[a-z0-9][a-z0-9._-]{1,79}$/),
  operation: SocQueryOperationSchema,
  subject: SocSubjectSchema,
  timeFrom: z.string().datetime({ offset: true }),
  timeTo: z.string().datetime({ offset: true }),
  maxPages: z.number().int().min(1).max(100),
  maxRows: z.number().int().min(1).max(10_000),
}).strict();

export const SocQueryPlanSchema = z.object({
  mission: SocMissionSchema,
  tenantId: SocIdentifierSchema,
  actorId: SocIdentifierSchema,
  timeFrom: z.string().datetime({ offset: true }),
  timeTo: z.string().datetime({ offset: true }),
  timezone: z.literal('UTC'),
  windowSemantics: z.literal('half-open'),
  providerSchema: z.object({
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(80),
    adapterVersion: z.string().min(1).max(80),
  }).strict(),
  queries: z.array(SocQueryPlanItemSchema).min(1).max(40),
}).strict();

export const SocQueryReceiptSchema = z.object({
  queryId: z.string().regex(/^qry-[a-z0-9][a-z0-9._-]{1,79}$/),
  operation: SocQueryOperationSchema,
  subject: SocSubjectSchema,
  tenantId: SocIdentifierSchema,
  actorId: SocIdentifierSchema,
  timeFrom: z.string().datetime({ offset: true }),
  timeTo: z.string().datetime({ offset: true }),
  pages: z.number().int().min(0).max(100),
  rows: z.number().int().min(0).max(10_000),
  cursorExhausted: z.boolean(),
  responseSha256: SocSha256Schema,
}).strict();

const SocScalarSchema = z.union([
  z.string().max(320),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const SocEvidenceRecordSchema = z.object({
  locator: SocEvidenceLocatorSchema.refine((value) => value.startsWith('rec-')),
  sourceQueryIds: z.array(z.string().regex(/^qry-[a-z0-9][a-z0-9._-]{1,79}$/)).min(1).max(10),
  timestamp: z.string().datetime({ offset: true }),
  kind: z.string().min(1).max(120),
  entityRefs: z.array(z.string().min(1).max(320)).max(20),
  facts: z.record(z.string().min(1).max(80), SocScalarSchema),
}).strict();

export const SocAggregateSchema = z.object({
  locator: SocEvidenceLocatorSchema.refine((value) => value.startsWith('agg-')),
  sourceQueryIds: z.array(z.string().regex(/^qry-[a-z0-9][a-z0-9._-]{1,79}$/)).min(1).max(10),
  metric: z.string().min(1).max(120),
  value: z.number().finite(),
  dimensions: z.record(z.string().min(1).max(80), z.string().max(320)),
}).strict();

export const SocPreparedSnapshotUnsignedSchema = z.object({
  schema: z.literal('nunchi.soc.prepared-snapshot.v1'),
  snapshotId: z.string().regex(/^snap-[a-z0-9][a-z0-9._-]{1,79}$/),
  mission: SocMissionSchema,
  tenantId: SocIdentifierSchema,
  actorId: SocIdentifierSchema,
  createdAt: z.string().datetime({ offset: true }),
  timeFrom: z.string().datetime({ offset: true }),
  timeTo: z.string().datetime({ offset: true }),
  timezone: z.literal('UTC'),
  windowSemantics: z.literal('half-open'),
  providerSchema: z.object({
    name: z.string().min(1).max(120),
    version: z.string().min(1).max(80),
    adapterVersion: z.string().min(1).max(80),
  }).strict(),
  classification: SocClassificationSchema,
  containsSecrets: z.literal(false),
  containsRawPii: z.literal(false),
  redactionReceipt: SocRedactionReceiptSchema,
  coverage: z.object({
    complete: z.boolean(),
    gaps: z.array(z.string().min(1).max(500)).max(20),
  }).strict(),
  queryReceipts: z.array(SocQueryReceiptSchema).min(1).max(40),
  records: z.array(SocEvidenceRecordSchema).max(2_000),
  aggregates: z.array(SocAggregateSchema).min(1).max(500),
}).strict();

export const SocPreparedSnapshotSchema = SocPreparedSnapshotUnsignedSchema.extend({
  snapshotSha256: SocSha256Schema,
}).strict();

export const SocEpistemicStatusSchema = z.enum(['observed', 'supported', 'unverified']);
const SocAssertionValueSchema = z.union([
  z.string().max(320),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export const SocEvidenceAssertionSchema = z.object({
  locator: SocEvidenceLocatorSchema,
  field: z.string().regex(/^(?:kind|timestamp|entityRefs|metric|value|facts\.[A-Za-z0-9_.-]+|dimensions\.[A-Za-z0-9_.-]+)$/),
  operator: z.enum(['equals', 'contains']),
  expected: SocAssertionValueSchema,
}).strict();
export const SocClaimSchema = z.object({
  claimKey: z.string().regex(/^claim-[a-z0-9][a-z0-9._-]{1,79}$/),
  category: z.enum(['pattern', 'entity', 'timeline', 'control', 'data-quality']),
  statement: z.string().min(1).max(2_000),
  epistemicStatus: SocEpistemicStatusSchema,
  evidenceLocators: z.array(SocEvidenceLocatorSchema).min(1).max(30),
  evidenceAssertions: z.array(SocEvidenceAssertionSchema).min(1).max(30),
  counterEvidenceLocators: z.array(SocEvidenceLocatorSchema).max(30),
  alternativeExplanations: z.array(z.string().min(1).max(1_000)).min(1).max(5),
  limitations: z.array(z.string().min(1).max(1_000)).min(1).max(10),
}).strict();

export const SocAdvisoryActionSchema = z.object({
  actionKey: z.string().regex(/^action-[a-z0-9][a-z0-9._-]{1,79}$/),
  actionType: z.enum([
    'collect-additional-evidence',
    'validate-control',
    'request-human-review',
    'continue-monitoring',
  ]),
  subject: z.string().min(1).max(320),
  rationale: z.string().min(1).max(1_000),
  evidenceLocators: z.array(SocEvidenceLocatorSchema).min(1).max(20),
}).strict();

export const SocHypothesisSchema = z.object({
  hypothesisKey: z.string().regex(/^hyp-[a-z0-9][a-z0-9._-]{1,79}$/),
  statement: z.string().min(1).max(2_000),
  disposition: z.enum(['supported', 'possible', 'rejected']),
  evidenceLocators: z.array(SocEvidenceLocatorSchema).min(1).max(30),
  counterEvidenceLocators: z.array(SocEvidenceLocatorSchema).max(30),
  prerequisites: z.array(z.string().min(1).max(1_000)).min(1).max(10),
  limitations: z.array(z.string().min(1).max(1_000)).min(1).max(10),
}).strict();

const SocHypothesisReviewSchema = z.object({
  hypothesisKey: z.string().regex(/^hyp-[a-z0-9][a-z0-9._-]{1,79}$/),
  decision: z.enum(['reconciled', 'unsupported', 'uncertain']),
  evidenceLocators: z.array(SocEvidenceLocatorSchema).min(1).max(30),
  counterEvidenceLocators: z.array(SocEvidenceLocatorSchema).max(30),
  reason: z.string().min(1).max(1_000),
}).strict();

const SocAdvisoryActionReviewSchema = z.object({
  actionKey: z.string().regex(/^action-[a-z0-9][a-z0-9._-]{1,79}$/),
  decision: z.enum(['proportionate', 'unsupported', 'uncertain']),
  evidenceLocators: z.array(SocEvidenceLocatorSchema).min(1).max(20),
  reason: z.string().min(1).max(1_000),
}).strict();

const identity = <TPhase extends string, TRole extends string>(phase: TPhase, role: TRole) => ({
  contractVersion: z.literal(SOC_CONTRACT_VERSION),
  phase: z.literal(phase),
  role: z.literal(role),
  snapshotId: z.string().regex(/^snap-[a-z0-9][a-z0-9._-]{1,79}$/),
  snapshotSha256: SocSha256Schema,
});

const blocked = <TPhase extends string, TRole extends string>(phase: TPhase, role: TRole) => z.object({
  ...identity(phase, role),
  status: z.literal('blocked'),
  summary: z.string().min(1).max(2_000),
  unresolved: z.array(z.string().min(1).max(1_000)).min(1).max(20),
}).strict();

export const SocReportEvidenceReviewPayloadSchema = z.discriminatedUnion('status', [
  z.object({
    ...identity('evidence-review', 'soc-report-evidence-reviewer'),
    status: z.literal('complete'),
    summary: z.string().min(1).max(2_000),
    coverageAssessment: z.enum(['complete', 'partial']),
    availableLocators: z.array(SocEvidenceLocatorSchema).max(2_500),
    counterEvidenceLocators: z.array(SocEvidenceLocatorSchema).max(100),
    limitations: z.array(z.string().min(1).max(1_000)).max(20),
    biasRisks: z.array(z.string().min(1).max(1_000)).max(20),
    unresolved: z.array(z.string().min(1).max(1_000)).max(20),
  }).strict(),
  blocked('evidence-review', 'soc-report-evidence-reviewer'),
]);

export const SocReportJudgmentPayloadSchema = z.discriminatedUnion('status', [
  z.object({
    ...identity('judge', 'soc-reporter'),
    status: z.literal('complete'),
    claims: z.array(SocClaimSchema).min(1).max(30),
    dataQuality: z.array(z.string().min(1).max(1_000)).max(20),
    advisoryActions: z.array(SocAdvisoryActionSchema).max(10),
    unresolved: z.array(z.string().min(1).max(1_000)).max(20),
  }).strict(),
  blocked('judge', 'soc-reporter'),
]);

export const SocReportVerificationPayloadSchema = z.discriminatedUnion('status', [
  z.object({
    ...identity('verify', 'soc-report-verifier'),
    status: z.literal('complete'),
    summary: z.string().min(1).max(2_000),
    claimReviews: z.array(z.object({
      claimKey: z.string().regex(/^claim-[a-z0-9][a-z0-9._-]{1,79}$/),
      decision: z.enum(['supported', 'unsupported', 'uncertain']),
      evidenceLocators: z.array(SocEvidenceLocatorSchema).min(1).max(30),
      reason: z.string().min(1).max(1_000),
    }).strict()).min(1).max(30),
    actionReviews: z.array(SocAdvisoryActionReviewSchema).max(10),
    anchoringChecked: z.boolean(),
    counterEvidenceChecked: z.boolean(),
    alternativesChecked: z.boolean(),
    coverageQualified: z.boolean(),
    gateDecision: z.enum(['pass', 'hold']),
    unresolved: z.array(z.string().min(1).max(1_000)).max(20),
  }).strict(),
  blocked('verify', 'soc-report-verifier'),
]);

export const SocInvestigationEvidenceReviewPayloadSchema = z.discriminatedUnion('status', [
  z.object({
    ...identity('evidence-review', 'soc-investigation-evidence-reviewer'),
    status: z.literal('complete'),
    summary: z.string().min(1).max(2_000),
    coverageAssessment: z.enum(['complete', 'partial']),
    reviewedQueryIds: z.array(z.string().regex(/^qry-[a-z0-9][a-z0-9._-]{1,79}$/)).max(40),
    availableLocators: z.array(SocEvidenceLocatorSchema).max(2_500),
    missingDirections: z.array(z.enum(['source', 'destination'])).max(2),
    limitations: z.array(z.string().min(1).max(1_000)).max(20),
    biasRisks: z.array(z.string().min(1).max(1_000)).max(20),
    unresolved: z.array(z.string().min(1).max(1_000)).max(20),
  }).strict(),
  blocked('evidence-review', 'soc-investigation-evidence-reviewer'),
]);

export const SocInvestigationAnalysisPayloadSchema = z.discriminatedUnion('status', [
  z.object({
    ...identity('analyze', 'soc-investigator'),
    status: z.literal('complete'),
    claims: z.array(SocClaimSchema).min(1).max(40),
    hypotheses: z.array(SocHypothesisSchema).min(1).max(20),
    advisoryActions: z.array(SocAdvisoryActionSchema).max(10),
    unresolved: z.array(z.string().min(1).max(1_000)).max(20),
  }).strict(),
  blocked('analyze', 'soc-investigator'),
]);

export const SocInvestigationVerificationPayloadSchema = z.discriminatedUnion('status', [
  z.object({
    ...identity('verify', 'soc-investigation-verifier'),
    status: z.literal('complete'),
    summary: z.string().min(1).max(2_000),
    claimReviews: z.array(z.object({
      claimKey: z.string().regex(/^claim-[a-z0-9][a-z0-9._-]{1,79}$/),
      decision: z.enum(['supported', 'unsupported', 'uncertain']),
      evidenceLocators: z.array(SocEvidenceLocatorSchema).min(1).max(30),
      reason: z.string().min(1).max(1_000),
    }).strict()).min(1).max(40),
    actionReviews: z.array(SocAdvisoryActionReviewSchema).max(10),
    hypothesisReviews: z.array(SocHypothesisReviewSchema).min(1).max(20),
    queryCoverageChecked: z.boolean(),
    anchoringChecked: z.boolean(),
    counterEvidenceChecked: z.boolean(),
    alternativesChecked: z.boolean(),
    gateDecision: z.enum(['pass', 'hold']),
    unresolved: z.array(z.string().min(1).max(1_000)).max(20),
  }).strict(),
  blocked('verify', 'soc-investigation-verifier'),
]);

export type SocMission = z.infer<typeof SocMissionSchema>;
export type SocSubjectType = z.infer<typeof SocSubjectTypeSchema>;
export type SocAuthorizationContext = z.infer<typeof SocAuthorizationContextSchema>;
export type SocQueryPlan = z.infer<typeof SocQueryPlanSchema>;
export type SocPreparedSnapshot = z.infer<typeof SocPreparedSnapshotSchema>;
export type SocPreparedSnapshotUnsigned = z.infer<typeof SocPreparedSnapshotUnsignedSchema>;
export type SocRedactionReceipt = z.infer<typeof SocRedactionReceiptSchema>;
export type SocClaim = z.infer<typeof SocClaimSchema>;
export type SocAdvisoryAction = z.infer<typeof SocAdvisoryActionSchema>;
export type SocHypothesis = z.infer<typeof SocHypothesisSchema>;
export type SocReportEvidenceReviewPayload = z.infer<typeof SocReportEvidenceReviewPayloadSchema>;
export type SocReportJudgmentPayload = z.infer<typeof SocReportJudgmentPayloadSchema>;
export type SocReportVerificationPayload = z.infer<typeof SocReportVerificationPayloadSchema>;
export type SocInvestigationEvidenceReviewPayload = z.infer<typeof SocInvestigationEvidenceReviewPayloadSchema>;
export type SocInvestigationAnalysisPayload = z.infer<typeof SocInvestigationAnalysisPayloadSchema>;
export type SocInvestigationVerificationPayload = z.infer<typeof SocInvestigationVerificationPayloadSchema>;
