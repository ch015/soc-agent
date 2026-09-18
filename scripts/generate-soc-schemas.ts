import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';

import {
  SocInvestigationAnalysisPayloadSchema,
  SocInvestigationEvidenceReviewPayloadSchema,
  SocInvestigationVerificationPayloadSchema,
  SocPreparedSnapshotSchema,
  SocReportEvidenceReviewPayloadSchema,
  SocReportJudgmentPayloadSchema,
  SocReportVerificationPayloadSchema,
} from '../src/runtime/contracts/soc-schemas.js';

const root = resolve(import.meta.dirname, '..', 'domains', 'soc', 'contracts');

function write(name: string, value: unknown): void {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (process.argv.includes('--check')) {
    if (readFileSync(resolve(root, name), 'utf8') !== content) {
      throw new Error(`SOC schema is out of date: ${name}`);
    }
    return;
  }
  writeFileSync(resolve(root, name), content, 'utf8');
}

write('soc-report-source-schema.v1.json', {
  id: 'nunchi.soc.report.source-schemas.v1',
  schemas: {
    'nunchi.soc.prepared-snapshot.v1': z.toJSONSchema(SocPreparedSnapshotSchema),
  },
});

write('soc-report-result-schemas.v1.json', {
  id: 'nunchi.soc.report.result-schemas.v1',
  schemas: {
    'nunchi.soc.report.evidence-review-result.v1': z.toJSONSchema(SocReportEvidenceReviewPayloadSchema),
    'nunchi.soc.report.judgment-result.v1': z.toJSONSchema(SocReportJudgmentPayloadSchema),
    'nunchi.soc.report.verification-result.v1': z.toJSONSchema(SocReportVerificationPayloadSchema),
  },
});

write('soc-investigation-source-schema.v1.json', {
  id: 'nunchi.soc.investigation.source-schemas.v1',
  schemas: {
    'nunchi.soc.prepared-snapshot.v1': z.toJSONSchema(SocPreparedSnapshotSchema),
  },
});

write('soc-investigation-result-schemas.v1.json', {
  id: 'nunchi.soc.investigation.result-schemas.v1',
  schemas: {
    'nunchi.soc.investigation.evidence-review-result.v1': z.toJSONSchema(SocInvestigationEvidenceReviewPayloadSchema),
    'nunchi.soc.investigation.analysis-result.v1': z.toJSONSchema(SocInvestigationAnalysisPayloadSchema),
    'nunchi.soc.investigation.verification-result.v1': z.toJSONSchema(SocInvestigationVerificationPayloadSchema),
  },
});
