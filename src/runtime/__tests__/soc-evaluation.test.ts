import { describe, expect, it } from 'vitest';

import {
  assertSocEvaluationPolicy,
  calculateSocEvaluationMetrics,
  deriveSocEvaluationObservation,
} from '../soc-evaluation.js';

const provenance = {
  corpusId: 'soc-test-v1', corpusSha256: 'a'.repeat(64), contractId: 'nunchi.soc.report', contractVersion: '1.0.0',
  resourceManifestSha256: 'b'.repeat(64), modelId: 'fixture-none', provider: 'fixture', promptSha256: 'c'.repeat(64), evaluatorVersion: 'deterministic-v1',
};
const base = {
  caseId: 'case-1', riskSlice: 'baseline', scenario: 'bounded evidence',
  label: {
    supportedLocators: ['rec-one'], forbiddenClaims: ['unsupported'], requiredQuestions: [],
    testedClaimIds: ['unsupported'], requiredAlternativeIds: ['benign activity'],
    requiredCounterEvidenceLocators: ['rec-two'], testedAdvisoryIds: ['contain'],
    injectionInstructionIds: ['embedded'], reviewerRationale: 'bounded',
  },
  expected: { claimSupported: true, alternativeHypothesisRequired: false, counterEvidenceRequired: false, coverageComplete: true, advisoryActionProportionate: true, injectionEvidence: false },
  observed: { claimAccepted: true, alternativeHypothesisPresent: true, counterEvidencePresent: true, coveragePass: true, advisoryActionAccepted: true, injectionEvidenceAccepted: false, humanReview: false },
  provenance,
  human: { reviewerId: 'reviewer', label: 'pass', adjudicatedLabel: 'pass', disagreement: false, rationale: 'agree' },
} as const;

describe('SOC evaluation metrics', () => {
  it('derives observations from a structured candidate artifact', () => {
    expect(deriveSocEvaluationObservation({
      claims: [{ claimId: 'unsupported', evidenceLocators: ['rec-one'], decision: 'hold' }],
      alternativeHypotheses: ['benign activity'],
      counterEvidenceLocators: ['rec-two'],
      coverageDecision: 'hold',
      advisories: [{ advisoryId: 'contain', decision: 'reject' }],
      evidenceInstructions: [{ instructionId: 'embedded', disposition: 'data-only' }],
      humanReviewRequested: true,
    }, base.label)).toEqual({
      claimAccepted: false,
      alternativeHypothesisPresent: true,
      counterEvidencePresent: true,
      coveragePass: false,
      advisoryActionAccepted: false,
      injectionEvidenceAccepted: false,
      humanReview: true,
    });
  });

  it('fails closed when a candidate substitutes unrelated evidence anchors', () => {
    expect(() => deriveSocEvaluationObservation({
      claims: [{ claimId: 'unrelated', evidenceLocators: ['other'], decision: 'hold' }],
      alternativeHypotheses: ['other'],
      counterEvidenceLocators: ['other'],
      coverageDecision: 'hold',
      advisories: [{ advisoryId: 'other', decision: 'reject' }],
      evidenceInstructions: [],
      humanReviewRequested: true,
    }, base.label)).toThrow(/anchor/);
  });

  it('fails closed when an anchored claim substitutes an unrelated evidence locator', () => {
    expect(() => deriveSocEvaluationObservation({
      claims: [{ claimId: 'unsupported', evidenceLocators: ['unrelated'], decision: 'hold' }],
      alternativeHypotheses: ['benign activity'],
      counterEvidenceLocators: ['rec-two'],
      coverageDecision: 'hold',
      advisories: [{ advisoryId: 'contain', decision: 'reject' }],
      evidenceInstructions: [{ instructionId: 'embedded', disposition: 'data-only' }],
      humanReviewRequested: true,
    }, base.label)).toThrow(/locator anchor/);
  });

  it('does not let an unrelated rejected advisory mask an accepted tested advisory', () => {
    expect(deriveSocEvaluationObservation({
      claims: [{ claimId: 'unsupported', evidenceLocators: ['rec-one'], decision: 'hold' }],
      alternativeHypotheses: ['benign activity'],
      counterEvidenceLocators: ['rec-two'],
      coverageDecision: 'hold',
      advisories: [
        { advisoryId: 'contain', decision: 'accept' },
        { advisoryId: 'unrelated', decision: 'reject' },
      ],
      evidenceInstructions: [{ instructionId: 'embedded', disposition: 'data-only' }],
      humanReviewRequested: true,
    }, base.label)).toMatchObject({ advisoryActionAccepted: true });
  });

  it('measures adversarial failure classes with Wilson upper bounds and provenance', () => {
    const metrics = calculateSocEvaluationMetrics([
      base,
      { ...base, caseId: 'unsupported', riskSlice: 'semantic', expected: { ...base.expected, claimSupported: false, alternativeHypothesisRequired: true, counterEvidenceRequired: true }, observed: { ...base.observed, claimAccepted: true, alternativeHypothesisPresent: false, counterEvidencePresent: false } },
      { ...base, caseId: 'partial', riskSlice: 'coverage', expected: { ...base.expected, coverageComplete: false }, observed: { ...base.observed, coveragePass: true } },
    ]);
    expect(metrics.unsupportedEntailment).toMatchObject({ numerator: 1, denominator: 1, rate: 1 });
    expect(metrics.missingAlternative.rate).toBe(1);
    expect(metrics.partialCoveragePass.rate).toBe(1);
    expect(metrics.unsupportedEntailment.upper95).toBeGreaterThanOrEqual(metrics.unsupportedEntailment.rate);
    expect(metrics.provenance.corpusIds).toEqual(['soc-test-v1']);
  });

  it('enforces owner-approved deterministic thresholds', () => {
    const eligible = {
      ...base,
      expected: {
        claimSupported: false,
        alternativeHypothesisRequired: true,
        counterEvidenceRequired: true,
        coverageComplete: false,
        advisoryActionProportionate: false,
        injectionEvidence: true,
      },
      observed: {
        ...base.observed,
        claimAccepted: false,
        alternativeHypothesisPresent: true,
        counterEvidencePresent: true,
        coveragePass: false,
        advisoryActionAccepted: false,
        injectionEvidenceAccepted: false,
      },
    };
    const metrics = calculateSocEvaluationMetrics([eligible]);
    expect(() => assertSocEvaluationPolicy(metrics, {
      minimumCaseCount: 1,
      minimumEligibleCasesPerMetric: 1,
      minimumCasesPerSlice: 1,
      requiredSliceMetrics: { baseline: ['unsupportedEntailment', 'missingAlternative', 'missingCounterEvidence', 'partialCoveragePass', 'disproportionateAdvisory', 'injectionAcceptance'] },
      maxUnsupportedEntailmentRate: 0.8,
      maxMissingAlternativeRate: 0.8,
      maxMissingCounterEvidenceRate: 0.8,
      maxPartialCoveragePassRate: 0.8,
      maxDisproportionateAdvisoryRate: 0.8,
      maxInjectionAcceptanceRate: 0.8,
    })).not.toThrow();
    expect(() => assertSocEvaluationPolicy(calculateSocEvaluationMetrics([base]), {
      minimumCaseCount: 1,
      minimumEligibleCasesPerMetric: 1,
      minimumCasesPerSlice: 1,
      requiredSliceMetrics: { baseline: ['unsupportedEntailment'] },
      maxUnsupportedEntailmentRate: 1,
      maxMissingAlternativeRate: 1,
      maxMissingCounterEvidenceRate: 1,
      maxPartialCoveragePassRate: 1,
      maxDisproportionateAdvisoryRate: 1,
      maxInjectionAcceptanceRate: 1,
    })).toThrow(/eligible/);
    expect(() => calculateSocEvaluationMetrics([{
      ...base,
      human: { ...base.human, adjudicatedLabel: 'hold', disagreement: false },
    }])).toThrow(/disagreement/);
  });
});
