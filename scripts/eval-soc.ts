import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assertSocEvaluationPolicy,
  calculateSocEvaluationMetrics,
  deriveSocEvaluationObservation,
} from '../src/runtime/soc-evaluation.js';

const root = resolve(import.meta.dirname, '..');
const casePath = resolve(root, process.argv[2] ?? 'evals/soc/cases/seed.v1.json');
const policyPath = resolve(root, process.argv[3] ?? 'evals/soc/policy.v1.json');
const caseContent = readFileSync(casePath);
const rawCases = JSON.parse(caseContent.toString('utf8')) as unknown;
if (!Array.isArray(rawCases)) throw new Error('SOC evaluation case 문서는 배열이어야 한다');
type Resource = { path: string; sha256: string };
type Contract = { id: string; version: string; resources: Resource[] };
const contracts = new Map<string, Contract>();
for (const name of ['soc-report-contract.v1.json', 'soc-investigation-contract.v1.json']) {
  const contract = JSON.parse(readFileSync(resolve(root, 'domains/soc/contracts', name), 'utf8')) as Contract;
  contracts.set(contract.id, contract);
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const resourceBundleHash = (contract: Contract, markdownOnly: boolean) => {
  const hash = createHash('sha256');
  for (const resource of [...contract.resources].sort((left, right) => left.path.localeCompare(right.path))) {
    if (markdownOnly && !resource.path.endsWith('.md')) continue;
    const content = readFileSync(resolve(root, 'domains/soc', resource.path));
    if (digest(content) !== resource.sha256) throw new Error(`SOC eval resource hash가 다르다: ${resource.path}`);
    hash.update(resource.path).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
};
const cases = rawCases.map((value) => {
  const item = value as Record<string, unknown>;
  const { candidate, ...labeledCase } = item;
  const declared = item.provenance as { contractId?: string } | undefined;
  const contract = declared?.contractId ? contracts.get(declared.contractId) : undefined;
  if (!contract) throw new Error(`SOC eval contract provenance가 잘못됐다: ${declared?.contractId ?? '(none)'}`);
  return {
    ...labeledCase,
    observed: deriveSocEvaluationObservation(candidate, item.label),
    provenance: {
      corpusId: 'soc-seed-v1',
      corpusSha256: digest(caseContent),
      contractId: contract.id,
      contractVersion: contract.version,
      resourceManifestSha256: resourceBundleHash(contract, false),
      modelId: 'not-executed',
      provider: 'none',
      promptSha256: resourceBundleHash(contract, true),
      evaluatorVersion: 'candidate-artifact-evaluator-v3',
    },
  };
});
const metrics = calculateSocEvaluationMetrics(cases);
assertSocEvaluationPolicy(metrics, JSON.parse(readFileSync(policyPath, 'utf8')));
console.log(JSON.stringify({
  schema: 'nunchi.soc.evaluation-run.v1',
  runType: 'deterministic-candidate-artifact-evaluation',
  agentQualityMeasured: false,
  repositoryEvaluatorExecuted: true,
  hostControlExecuted: false,
  liveProviderExecuted: false,
  liveSourceExecuted: false,
  limitations: ['candidate artifacts are fixed corpus inputs rather than live model outputs; promptSha256 covers trusted markdown resource bytes, not a live assembled prompt; this run measures evaluator behavior, not agent quality, calibration, or bias'],
  metrics,
}, null, 2));
