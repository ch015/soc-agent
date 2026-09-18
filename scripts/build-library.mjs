import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', join(root, 'tsconfig.library.json')], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status ?? 1);
for (const name of ['domains', 'templates']) {
  const from = join(root, name);
  if (existsSync(from)) cpSync(from, join(dist, name), { recursive: true, filter: file => {
    const parts = file.slice(root.length + 1).split('/');
    return !parts.some(p => ['node_modules', '.git', '__tests__', 'test', '.nunchi', '.recon-cache', 'engagements'].includes(p)
      || /(^|\.)env($|\.)/.test(p) && !p.endsWith('.env.example'));
  } });
}
// Runtime migrations are resources; tsc only emits TypeScript dependencies.
function copySql(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '__tests__') copySql(file);
    else if (entry.isFile() && entry.name.endsWith('.sql')) {
      const to = join(dist, file.slice(root.length + 1)); mkdirSync(dirname(to), { recursive: true }); cpSync(file, to);
    }
  }
}
copySql(join(root, 'src/runtime'));
console.log('Library ready: dist/src/index.js (ESM) and dist/src/index.d.ts');
