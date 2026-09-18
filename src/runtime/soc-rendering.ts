import type {
  SocAdvisoryAction,
  SocClaim,
  SocHypothesis,
  SocPreparedSnapshot,
} from './contracts/soc-schemas.js';

type EvidenceRenderInput = { summary: string; limitations: string[]; biasRisks: string[] };
type VerificationRenderInput = {
  summary: string;
  gateDecision: 'pass' | 'hold';
  unresolved: string[];
  claimReviews: Array<{ claimKey: string; decision: string; reason: string }>;
  actionReviews: Array<{ actionKey: string; decision: string; reason: string }>;
  hypothesisReviews?: Array<{ hypothesisKey: string; decision: string; reason: string }>;
};

export function renderSocReportDraft(
  snapshot: SocPreparedSnapshot,
  evidence: EvidenceRenderInput,
  judgment: { claims: SocClaim[]; dataQuality: string[]; advisoryActions: SocAdvisoryAction[] },
  verification: VerificationRenderInput,
): string {
  return renderDraft('SOC Report Draft', snapshot, evidence, judgment.claims, judgment.advisoryActions, verification, judgment.dataQuality);
}

export function renderSocInvestigationDraft(
  snapshot: SocPreparedSnapshot,
  evidence: EvidenceRenderInput,
  analysis: { claims: SocClaim[]; hypotheses: SocHypothesis[]; advisoryActions: SocAdvisoryAction[] },
  verification: VerificationRenderInput,
): string {
  return renderDraft('SOC Investigation Draft', snapshot, evidence, analysis.claims, analysis.advisoryActions, verification, [], analysis.hypotheses);
}

function renderDraft(
  title: string,
  snapshot: SocPreparedSnapshot,
  evidence: EvidenceRenderInput,
  claims: SocClaim[],
  actions: SocAdvisoryAction[],
  verification: VerificationRenderInput,
  dataQuality: string[] = [],
  hypotheses: SocHypothesis[] = [],
): string {
  const claimReviews = new Map(verification.claimReviews.map((review) => [review.claimKey, review]));
  const actionReviews = new Map(verification.actionReviews.map((review) => [review.actionKey, review]));
  const hypothesisReviews = new Map((verification.hypothesisReviews ?? []).map((review) => [review.hypothesisKey, review]));
  const lines = [
    `# ${title}`,
    '',
    `Status: ${verification.gateDecision === 'pass' ? 'INTERNAL REVIEWED DRAFT' : 'HOLD — NOT CLEARED'}`,
    `Snapshot: ${snapshot.snapshotId} (${snapshot.snapshotSha256})`,
    `Coverage: ${snapshot.coverage.complete ? 'complete' : 'partial'}`,
    '',
    '## Summary',
    '',
    `The host accepted ${claims.length} structurally grounded claim(s) for this internal draft. Locator presence is not proof of semantic entailment.`,
    '',
    '## Claims',
    '',
    ...claims.flatMap((claim) => [
      `### ${safe(claim.claimKey)} — ${claim.epistemicStatus}`,
      '',
      safe(claim.statement),
      '',
      `Evidence: ${claim.evidenceLocators.join(', ')}`,
      `Machine checks: ${claim.evidenceAssertions.map((assertion) => `${assertion.locator}.${assertion.field} ${assertion.operator} ${JSON.stringify(assertion.expected)}`).join('; ')}`,
      `Counter-evidence: ${claim.counterEvidenceLocators.length > 0 ? claim.counterEvidenceLocators.join(', ') : 'none identified'}`,
      `Alternative explanations: ${claim.alternativeExplanations.map(safe).join('; ')}`,
      `Limitations: ${claim.limitations.map(safe).join('; ')}`,
      `Verifier: ${safe(claimReviews.get(claim.claimKey)?.decision ?? 'missing')} — ${safe(claimReviews.get(claim.claimKey)?.reason ?? 'missing review')}`,
      '',
    ]),
    ...(hypotheses.length > 0 ? [
      '## Hypotheses',
      '',
      ...hypotheses.flatMap((hypothesis) => {
        const review = hypothesisReviews.get(hypothesis.hypothesisKey);
        return [
          `### ${safe(hypothesis.hypothesisKey)} — ${hypothesis.disposition}`,
          '',
          safe(hypothesis.statement),
          `Evidence: ${hypothesis.evidenceLocators.join(', ')}`,
          `Counter-evidence: ${hypothesis.counterEvidenceLocators.length > 0 ? hypothesis.counterEvidenceLocators.join(', ') : 'none identified'}`,
          `Prerequisites: ${hypothesis.prerequisites.map(safe).join('; ')}`,
          `Limitations: ${hypothesis.limitations.map(safe).join('; ')}`,
          `Verifier: ${safe(review?.decision ?? 'missing')} — ${safe(review?.reason ?? 'missing review')}`,
          '',
        ];
      }),
    ] : []),
    '## Data quality',
    '',
    ...(dataQuality.length > 0 ? dataQuality.map((item) => `- ${safe(item)}`) : ['- No additional data-quality note supplied.']),
    '',
    '## Evidence-first review',
    '',
    `The evidence-first phase reviewed ${snapshot.records.length} record(s), ${snapshot.aggregates.length} aggregate(s), and recorded ${evidence.limitations.length} limitation(s) plus ${evidence.biasRisks.length} bias-risk note(s).`,
    `Limitations: ${evidence.limitations.length > 0 ? evidence.limitations.map(safe).join('; ') : 'none recorded'}`,
    `Bias risks: ${evidence.biasRisks.length > 0 ? evidence.biasRisks.map(safe).join('; ') : 'none recorded'}`,
    '',
    '## Advisory next steps',
    '',
    ...(actions.length > 0 ? actions.map((action) => {
      const review = actionReviews.get(action.actionKey);
      return `- ${action.actionType} for ${safe(action.subject)} — ${safe(action.rationale)} [verifier: ${safe(review?.decision ?? 'missing')} — ${safe(review?.reason ?? 'missing review')}]`;
    }) : ['- None proposed.']),
    '',
    '## Verification',
    '',
    `The verification phase reviewed ${claims.length} claim(s). Host structural gate: ${verification.gateDecision}; unresolved note count: ${verification.unresolved.length}.`,
    ...(verification.unresolved.length > 0 ? verification.unresolved.map((item) => `- ${safe(item)}`) : ['- No unresolved note.']),
    '',
    '> This is an internal technical draft. It is not a legal/compliance determination and authorizes no operational action.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function safe(value: string): string {
  return value.replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
