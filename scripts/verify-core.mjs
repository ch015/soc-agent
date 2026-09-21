// Real package-manager install into an unrelated temporary app. No live model calls.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
const app = realpathSync(mkdtempSync(join(tmpdir(), 'agent-core-install-')));
const env = { ...process.env }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: app, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
const bytes = path => readdirSync(path, { withFileTypes: true }).reduce((sum, e) => {
  const child = join(path, e.name); return sum + (e.isDirectory() ? bytes(child) : e.isSymbolicLink() ? 0 : statSync(child).size);
}, 0);
try {
  writeFileSync(join(app, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [pkg.name]: `file:${root}` } }));
  run('npm', ['install', '--omit=dev', '--ignore-scripts', '--install-links', '--no-audit', '--no-fund']);
  const installed = readdirSync(join(app, 'node_modules')).filter(name => !name.startsWith('.')).sort();
  assert.deepEqual(installed, [pkg.name, 'zod'].sort());
  const dependencyBytes = bytes(join(app, 'node_modules/zod'));
  const installedBytes = bytes(join(app, 'node_modules'));
  const distBytes = bytes(join(app, 'node_modules', pkg.name, 'dist'));
  const ts = require('typescript');

  cpSync(join(root, 'scripts/verify-core-consumer.mjs'), join(app, 'consumer.mjs'));
  const consumer = JSON.parse(run(process.execPath, ['consumer.mjs']).trim().split('\n').at(-1));
  // Only Node's ambient types are copied for TS validation; no SDK or PostgreSQL types are present.
  const nodeTypes = realpathSync(join(root, 'node_modules/@types/node'));
  cpSync(nodeTypes, join(app, 'types/node'), { recursive: true });
  cpSync(realpathSync(createRequire(join(nodeTypes, 'package.json')).resolve('undici-types/package.json')).replace(/package.json$/, ''), join(app, 'types/node/node_modules/undici-types'), { recursive: true });
  writeFileSync(join(app, 'consumer.mts'), "import { createSocAgent, SocLlmClient, type AssessmentGuard } from 'secops-soc-agent'; const guard: AssessmentGuard = () => undefined; const agent = createSocAgent({ llm: new SocLlmClient(), dataSource: { createConnector: () => ({ execute: async () => ({}) }) }, assessmentGuard: guard, limits: { maxConcurrentTools: 2 } }); void agent;");
  run(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', 'false', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--typeRoots', './types', '--types', 'node', 'consumer.mts']);
  writeFileSync(join(app, 'import.mjs'), `const before = process.memoryUsage().rss; const start = performance.now(); await import(${JSON.stringify(pkg.name)}); console.log(JSON.stringify({ ms: performance.now()-start, rssDelta: process.memoryUsage().rss-before }));`);
  const samples = Array.from({ length: 5 }, () => JSON.parse(run(process.execPath, ['import.mjs'])));
  const median = values => values.sort((a,b) => a-b)[Math.floor(values.length/2)];
  const result = { installed, dependencyBytes, installedBytes, distBytes, strictTypecheck: 'passed', consumer,
    importMedianMs: median(samples.map(s => s.ms)), importMedianRssBytes: median(samples.map(s => s.rssDelta)),
    liveModelCalls: false, liveSourceCalls: false, method: 'npm production file install with install-links; no modified manifest, no workspace symlinks' };
  if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(result, null, 2)+'\n');
  console.log(JSON.stringify(result, null, 2));
} finally { rmSync(app, { recursive: true, force: true }); }
