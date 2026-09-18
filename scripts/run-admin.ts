import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { HostInputRecordSchema } from '../src/runtime/workflow/state-store.js';
import { openMissionRuntime, type MissionRuntimeOptions } from '../src/runtime/workflow/mission-runtime.js';
import {
  inspectRun,
  reconcileIncompleteAttempt,
  resumeRunWithInput,
  type ReconcileReasonCode,
} from '../src/runtime/workflow/reconciliation.js';
import { FileTelemetrySink, recordRunTelemetry } from '../src/runtime/workflow/telemetry.js';

type Parsed = { command: string; flags: Map<string, string> };

function parseArgs(argv: readonly string[]): Parsed {
  const [command = '', ...rest] = argv;
  const flags = new Map<string, string>();
  for (const value of rest) {
    if (!value.startsWith('--') || !value.includes('=')) throw new Error(`잘못된 인수다: ${value}`);
    const [key, ...parts] = value.slice(2).split('=');
    flags.set(key!, parts.join('='));
  }
  return { command, flags };
}

function required(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value) throw new Error(`--${key}가 필요하다`);
  return value;
}

function integer(flags: Map<string, string>, key: string): number {
  const value = Number(required(flags, key));
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${key}가 음이 아닌 정수가 아니다`);
  return value;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (!['inspect', 'reconcile', 'resume'].includes(command)) {
    throw new Error('사용: pnpm run:admin <inspect|reconcile|resume> --engagement=<dir> --run-id=<id> [options]');
  }
  const engagementDir = resolve(required(flags, 'engagement'));
  const runId = required(flags, 'run-id');
  const backend = flags.get('backend') as MissionRuntimeOptions['backend'] | undefined;
  const telemetry = new FileTelemetrySink(resolve(flags.get('telemetry') ?? join(engagementDir, 'run-telemetry.jsonl')));
  const runtime = await openMissionRuntime({ engagementDir, runId }, { ...(backend ? { backend } : {}), telemetry });
  try {
    if (command === 'inspect') {
      const inspection = await inspectRun(runtime.state);
      await recordRunTelemetry(telemetry, await runtime.read(), { kind: 'run.snapshot' });
      process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
      return;
    }
    const expectedVersion = integer(flags, 'expected-version');
    const fencingToken = runtime.leaseGuard?.fencingToken();
    if (command === 'reconcile') {
      const reasonCode = required(flags, 'reason') as ReconcileReasonCode;
      if (!['provider-error', 'accounting-incomplete', 'lease-lost', 'unknown'].includes(reasonCode)) {
        throw new Error(`--reason이 잘못됐다: ${reasonCode}`);
      }
      await reconcileIncompleteAttempt({
        state: runtime.state,
        expectedVersion,
        phase: required(flags, 'phase'),
        ...(flags.has('round') ? { round: flags.get('round')! } : {}),
        attempt: integer(flags, 'attempt'),
        reasonCode,
        ...(fencingToken === undefined ? {} : { fencingToken }),
        telemetry,
      });
      process.stdout.write(`${JSON.stringify(await inspectRun(runtime.state), null, 2)}\n`);
      return;
    }
    const revisedInput = HostInputRecordSchema.parse(JSON.parse(
      await readFile(resolve(required(flags, 'input-json')), 'utf8'),
    ) as unknown);
    await resumeRunWithInput({
      state: runtime.state,
      expectedVersion,
      revisedInput,
      ...(fencingToken === undefined ? {} : { fencingToken }),
      telemetry,
    });
    process.stdout.write(`${JSON.stringify(await inspectRun(runtime.state), null, 2)}\n`);
  } finally {
    await runtime.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
