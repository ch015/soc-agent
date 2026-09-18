import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';


export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
export const DOMAINS_ROOT = join(REPO_ROOT, 'domains');

export function domainPluginPath(domain: string): string {
  const path = join(DOMAINS_ROOT, domain);
  const manifest = join(path, '.claude-plugin', 'plugin.json');
  if (!existsSync(manifest)) {
    throw new Error(
      `도메인 플러그인 매니페스트가 없다: ${manifest}\n` +
        `domains/${domain}/.claude-plugin/plugin.json 이 있어야 SDK가 플러그인으로 로드한다.`,
    );
  }
  return path;
}

export function domainAgentNames(domain: string): Set<string> {
  const dir = join(domainPluginPath(domain), 'agents');
  if (!existsSync(dir)) return new Set();
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const match = /^name:\s*(.+)$/m.exec(readFileSync(join(dir, file), 'utf8'));
    if (match?.[1] !== undefined) names.add(match[1].trim());
  }
  return names;
}

const SAFE_PARENT_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'TMP', 'TEMP',
] as const;

export function safeParentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_PARENT_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
