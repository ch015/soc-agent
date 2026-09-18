import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { SocMissionSchema } from '../src/runtime/contracts/soc-schemas.js';
import { executeSocSnapshot, redactionTrustFromEnv } from '../src/runtime/soc-execution.js';

async function main() {
  const { values } = parseArgs({
    options: {
      snapshot: { type: 'string' }, mission: { type: 'string' },
      tenant: { type: 'string' }, actor: { type: 'string' },
      'engagement-dir': { type: 'string' }, model: { type: 'string' },
      'review-model': { type: 'string' }, 'max-turns': { type: 'string' },
      help: { type: 'boolean' },
    },
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
  });
  if (values.help) {
    console.log('Usage: pnpm soc:run --snapshot <file> --mission report|investigation --tenant <id> --actor <id> [--engagement-dir <dir>] [--model <id>] [--review-model <id>] [--max-turns <n>]');
    return;
  }
  if (!values.snapshot || !values.tenant || !values.actor) throw new Error('--snapshot, --tenant and --actor are required');
  const mission = SocMissionSchema.parse(values.mission);
  const content = readFileSync(resolve(values.snapshot));
  if (content.byteLength > 1_000_000) throw new Error('SOC snapshot exceeds 1 MB');
  const snapshot: unknown = JSON.parse(content.toString('utf8'));
  if (!snapshot || typeof snapshot !== 'object' || !('mission' in snapshot) || snapshot.mission !== mission) {
    throw new Error('Snapshot mission does not match --mission');
  }
  const maxTurns = values['max-turns'] === undefined ? undefined : Number(values['max-turns']);
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1)) throw new Error('--max-turns must be a positive integer');
  const result = await executeSocSnapshot(snapshot, {
    tenantId: values.tenant,
    actorId: values.actor,
    scopes: [mission === 'report' ? 'soc:report:read' : 'soc:investigation:read'],
  }, {
    ...(values['engagement-dir'] ? { engagementDir: resolve(values['engagement-dir']) } : {}),
    model: values.model, reviewModel: values['review-model'], maxTurns,
  }, { redactionTrust: redactionTrustFromEnv() });
  console.log(JSON.stringify({ status: result.status, mission: result.mission, engagementDir: result.engagementDir, draftPath: result.draftPath }, null, 2));
  if (result.status === 'held') process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
