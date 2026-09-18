import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { AgentDefinition, OutputFormat } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  SocInvestigationAnalysisPayloadSchema,
  SocInvestigationEvidenceReviewPayloadSchema,
  SocInvestigationVerificationPayloadSchema,
  SocPreparedSnapshotSchema,
  SocReportEvidenceReviewPayloadSchema,
  SocReportJudgmentPayloadSchema,
  SocReportVerificationPayloadSchema,
  type SocMission,
} from './contracts/soc-schemas.js';
import {
  getWorkflowPhase,
  parseWorkflowContract,
  type WorkflowContract,
  type WorkflowPhase,
} from './contracts/workflow-contract.js';
import { sha256, validateResourceManifest } from './contracts/resource-manifest.js';

export const SOC_ROOT = resolve(import.meta.dirname, '..', '..', 'domains', 'soc');

const CONTRACT_PATHS: Record<SocMission, string> = {
  report: join(SOC_ROOT, 'contracts', 'soc-report-contract.v1.json'),
  investigation: join(SOC_ROOT, 'contracts', 'soc-investigation-contract.v1.json'),
};

const SOURCE_SCHEMA_PATHS: Record<SocMission, string> = {
  report: 'contracts/soc-report-source-schema.v1.json',
  investigation: 'contracts/soc-investigation-source-schema.v1.json',
};

const RESULT_SCHEMA_PATHS: Record<SocMission, string> = {
  report: 'contracts/soc-report-result-schemas.v1.json',
  investigation: 'contracts/soc-investigation-result-schemas.v1.json',
};

const cache = new Map<SocMission, { contract: WorkflowContract; sourceSha256: string }>();

export function loadSocContract(mission: SocMission): WorkflowContract {
  const source = readFileSync(CONTRACT_PATHS[mission], 'utf8');
  const sourceSha256 = sha256(source);
  const cached = cache.get(mission);
  if (cached?.sourceSha256 === sourceSha256) {
    validateSocContractReferences(cached.contract, mission);
    return cached.contract;
  }
  const contract = parseWorkflowContract(JSON.parse(source) as unknown);
  validateSocContractReferences(contract, mission);
  cache.set(mission, { contract, sourceSha256 });
  return contract;
}

export function validateSocContractReferences(
  contract: WorkflowContract,
  mission: SocMission,
): void {
  if (
    contract.id !== `nunchi.soc.${mission}` ||
    contract.version !== '1.0.0' ||
    contract.domain !== 'soc' ||
    contract.mission !== mission
  ) {
    throw new Error(`SOC ${mission} contract identity가 다르다`);
  }
  if (contract.publication) {
    throw new Error('SOC v1 contract는 외부 publication 권한을 가질 수 없다');
  }
  if (contract.roles && Object.values(contract.roles).some((role) => role.tools.some((tool) => tool !== 'Read'))) {
    throw new Error(`SOC ${mission} role에는 Read 외 model tool을 허용할 수 없다`);
  }

  const expectedResources = [
    SOURCE_SCHEMA_PATHS[mission],
    RESULT_SCHEMA_PATHS[mission],
  ];
  for (const [name, role] of Object.entries(contract.roles)) {
    expectedResources.push(role.agentFile);
    assertAgentDefinition(name, role.agentFile);
    for (const skill of role.skills) expectedResources.push(resolveSkillPath(skill));
  }
  for (const phase of contract.phases) {
    expectedResources.push(...phase.requiredMethodFiles);
  }
  validateResourceManifest({
    resources: contract.resources,
    expectedPaths: expectedResources,
    root: SOC_ROOT,
    label: `SOC ${mission}`,
  });
  validateSchemaRegistry(mission, contract);
}

export function getSocPhase(
  mission: SocMission,
  id: string,
  contract = loadSocContract(mission),
): WorkflowPhase {
  return getWorkflowPhase(contract, id);
}

export function buildSocAgentDefinitions(
  mission: SocMission,
  contract = loadSocContract(mission),
): Record<string, AgentDefinition> {
  validateSocContractReferences(contract, mission);
  const definitions: Record<string, AgentDefinition> = {};
  for (const [name, role] of Object.entries(contract.roles)) {
    const text = readFileSync(resolveWithinSoc(role.agentFile), 'utf8');
    const parsed = parseAgentDocument(text, role.agentFile);
    if (parsed.name !== name) throw new Error(`SOC agent name과 contract role이 다르다: ${parsed.name}/${name}`);
    definitions[name] = {
      description: role.description,
      prompt: parsed.body,
      tools: [...role.tools],
      disallowedTools: [...contract.forbiddenModelTools],
      skills: [...role.skills],
      background: false,
    };
  }
  return definitions;
}

export function socOutputFormat(mission: SocMission, phase: WorkflowPhase): OutputFormat {
  const schema = z.toJSONSchema(schemaFor(mission, phase.id));
  // Strip $schema keyword — Claude CLI does not accept JSON Schema 2020-12 $schema field
  const { $schema: _, ...schemaWithout } = schema as Record<string, unknown>;
  // Claude API does not allow oneOf/anyOf/allOf at the top level of input_schema.
  if ('oneOf' in schemaWithout || 'anyOf' in schemaWithout || 'allOf' in schemaWithout) {
    return {
      type: 'json_schema',
      schema: {
        type: 'object',
        properties: { result: schemaWithout },
        required: ['result'],
        additionalProperties: false,
      },
    };
  }
  return { type: 'json_schema', schema: schemaWithout };
}

export function resolveSocContractResources(
  mission: SocMission,
  phase: WorkflowPhase,
): string[] {
  const contract = loadSocContract(mission);
  validateSocContractReferences(contract, mission);
  const role = contract.roles[phase.role];
  if (!role) throw new Error(`SOC phase role이 없다: ${phase.role}`);
  return [
    resolveWithinSoc(role.agentFile),
    ...role.skills.map((skill) => resolveWithinSoc(resolveSkillPath(skill))),
    ...phase.requiredMethodFiles.map(resolveWithinSoc),
  ];
}

function validateSchemaRegistry(mission: SocMission, contract: WorkflowContract): void {
  const source = readRegistry(SOURCE_SCHEMA_PATHS[mission]);
  const results = readRegistry(RESULT_SCHEMA_PATHS[mission]);
  const expectedSource = z.toJSONSchema(SocPreparedSnapshotSchema);
  if (!sameJson(source.schemas['nunchi.soc.prepared-snapshot.v1'], expectedSource)) {
    throw new Error(`SOC ${mission} source schema registry가 runtime과 다르다`);
  }
  const expectedPhaseIds = new Set<string>();
  for (const phase of contract.phases) {
    expectedPhaseIds.add(phase.resultSchemaId);
    const registered = results.schemas[phase.resultSchemaId];
    if (!registered || !sameJson(registered, z.toJSONSchema(schemaFor(mission, phase.id)))) {
      throw new Error(`SOC ${mission} result schema registry가 runtime과 다르다: ${phase.resultSchemaId}`);
    }
  }
  if (
    Object.keys(results.schemas).length !== expectedPhaseIds.size ||
    Object.keys(results.schemas).some((id) => !expectedPhaseIds.has(id))
  ) {
    throw new Error(`SOC ${mission} result schema registry에 orphan 또는 누락 schema가 있다`);
  }
}

function schemaFor(mission: SocMission, phase: string) {
  if (mission === 'report') {
    if (phase === 'evidence-review') return SocReportEvidenceReviewPayloadSchema;
    if (phase === 'judge') return SocReportJudgmentPayloadSchema;
    if (phase === 'verify') return SocReportVerificationPayloadSchema;
  } else {
    if (phase === 'evidence-review') return SocInvestigationEvidenceReviewPayloadSchema;
    if (phase === 'analyze') return SocInvestigationAnalysisPayloadSchema;
    if (phase === 'verify') return SocInvestigationVerificationPayloadSchema;
  }
  throw new Error(`알 수 없는 SOC ${mission} phase schema: ${phase}`);
}

function readRegistry(relativePath: string): { schemas: Record<string, unknown> } {
  const value = JSON.parse(readFileSync(resolveWithinSoc(relativePath), 'utf8')) as unknown;
  return z.object({
    id: z.string().min(1),
    schemas: z.record(z.string(), z.unknown()),
  }).strict().parse(value);
}

function assertAgentDefinition(expectedName: string, relativePath: string): void {
  const path = resolveWithinSoc(relativePath);
  if (!existsSync(path)) throw new Error(`SOC agent file이 없다: ${relativePath}`);
  const parsed = parseAgentDocument(readFileSync(path, 'utf8'), relativePath);
  if (parsed.name !== expectedName) {
    throw new Error(`SOC agent file name과 contract role이 다르다: ${parsed.name}/${expectedName}`);
  }
}

function parseAgentDocument(text: string, path: string): { name: string; body: string } {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/.exec(text);
  const name = frontmatter?.[1] ? /^name:\s*([^\r\n]+)$/m.exec(frontmatter[1])?.[1]?.trim() : undefined;
  if (!name || !frontmatter?.[2]?.trim()) throw new Error(`SOC agent frontmatter가 잘못됐다: ${path}`);
  return { name, body: frontmatter[2].trim() };
}

function resolveSkillPath(skill: string): string {
  const match = /^nunchi-soc:([a-z0-9-]+)$/.exec(skill);
  if (!match?.[1]) throw new Error(`SOC skill 이름이 잘못됐다: ${skill}`);
  return `skills/${match[1]}/SKILL.md`;
}

function resolveWithinSoc(relativePath: string): string {
  const path = resolve(SOC_ROOT, relativePath);
  if (path === SOC_ROOT || (dirname(path) !== SOC_ROOT && !path.startsWith(`${SOC_ROOT}/`))) {
    throw new Error(`SOC contract path가 도메인 밖이다: ${relativePath}`);
  }
  return path;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
