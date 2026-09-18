import { describe, expect, it } from 'vitest';

import { SocReportJudgmentPayloadSchema } from '../contracts/soc-schemas.js';
import { SocReportDomainAdapter } from '../domains/soc.js';
import {
  buildSocAgentDefinitions,
  loadSocContract,
  validateSocContractReferences,
} from '../soc-contract.js';

describe('SOC contract source of truth', () => {
  it('keeps report and investigation contracts, roles, skills, and schemas independent', () => {
    const report = loadSocContract('report');
    const investigation = loadSocContract('investigation');
    expect(report.id).toBe('nunchi.soc.report');
    expect(investigation.id).toBe('nunchi.soc.investigation');
    expect(Object.keys(report.roles).every((role) => role.includes('report') || role === 'soc-reporter')).toBe(true);
    expect(Object.keys(investigation.roles).every((role) => role.includes('investigation') || role === 'soc-investigator')).toBe(true);
    expect(report.resources.some((resource) => resource.path.includes('investigation'))).toBe(false);
    expect(investigation.resources.some((resource) => resource.path.includes('report'))).toBe(false);
    expect(Object.values(report.roles).flatMap((role) => role.skills)).toEqual([
      'nunchi-soc:soc-report-contract',
      'nunchi-soc:soc-report-contract',
      'nunchi-soc:soc-report-contract',
    ]);
  });

  it('pins every trusted agent, skill, method, and schema digest to the contract version', () => {
    const contract = structuredClone(loadSocContract('report'));
    contract.resources[0]!.sha256 = '0'.repeat(64);
    expect(() => validateSocContractReferences(contract, 'report')).toThrow(/digest/);
    expect(() => buildSocAgentDefinitions('report', contract)).toThrow(/digest/);
  });

  it('rejects vacuous report judgments and missing alternatives', () => {
    const base = {
      contractVersion: '1.0.0',
      phase: 'judge',
      role: 'soc-reporter',
      snapshotId: 'snap-report-001',
      snapshotSha256: 'a'.repeat(64),
      status: 'complete',
      dataQuality: [],
      advisoryActions: [],
      unresolved: [],
    } as const;
    expect(() => SocReportJudgmentPayloadSchema.parse({ ...base, claims: [] })).toThrow();
    expect(() => SocReportJudgmentPayloadSchema.parse({
      ...base,
      claims: [{
        claimKey: 'claim-test-001',
        category: 'timeline',
        statement: 'Observed activity.',
        epistemicStatus: 'observed',
        evidenceLocators: ['rec-test-001'],
        evidenceAssertions: [{
          locator: 'rec-test-001',
          field: 'facts.outcome',
          operator: 'equals',
          expected: 'success',
        }],
        counterEvidenceLocators: [],
        alternativeExplanations: [],
        limitations: ['Fixture only.'],
      }],
    })).toThrow();
  });

  it('rejects unknown result fields instead of accepting passthrough model output', () => {
    expect(() => SocReportJudgmentPayloadSchema.parse({
      contractVersion: '1.0.0',
      phase: 'judge',
      role: 'soc-reporter',
      snapshotId: 'snap-report-001',
      snapshotSha256: 'a'.repeat(64),
      status: 'complete',
      claims: [{
        claimKey: 'claim-test-001',
        category: 'timeline',
        statement: 'Observed authentication activity.',
        epistemicStatus: 'observed',
        evidenceLocators: ['rec-test-001'],
        evidenceAssertions: [{
          locator: 'rec-test-001',
          field: 'facts.outcome',
          operator: 'equals',
          expected: 'success',
        }],
        counterEvidenceLocators: [],
        alternativeExplanations: ['Expected activity remains possible.'],
        limitations: ['Fixture only.'],
      }],
      dataQuality: [],
      advisoryActions: [],
      unresolved: [],
      injectedAuthority: 'publish now',
    })).toThrow();
  });

  it('derives prior read artifacts from the phase contract rather than caller input', () => {
    const adapter = new SocReportDomainAdapter();
    const judge = adapter.getPhase('judge').legacy;
    expect(adapter.allowedPriorArtifacts(judge, {
      inputArtifacts: ['02_soc_report_evidence_review.json'],
    })).toEqual(['02_soc_report_evidence_review.json']);
    expect(() => adapter.allowedPriorArtifacts(judge, {
      inputArtifacts: ['03_soc_report_judgment.json'],
    })).toThrow(/phase 계약/);
  });
});
