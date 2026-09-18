import type { DomainAdapter } from './domain-adapter.js';
import { SocInvestigationDomainAdapter, SocReportDomainAdapter } from './soc.js';

export class DomainRegistry {
  private readonly factories = new Map<string, () => DomainAdapter>();

  register(domain: string, mission: string, factory: () => DomainAdapter): void {
    const key = identity(domain, mission);
    if (this.factories.has(key)) throw new Error(`domain adapter가 이미 등록됐다: ${key}`);
    this.factories.set(key, factory);
  }

  get(domain: string, mission?: string): DomainAdapter {
    const matches = mission
      ? [[identity(domain, mission), this.factories.get(identity(domain, mission))] as const]
      : [...this.factories.entries()].filter(([key]) => key.startsWith(`${domain}/`));
    const available = matches.filter((entry): entry is readonly [string, () => DomainAdapter] => Boolean(entry[1]));
    if (available.length === 0) {
      throw new Error(`domain adapter가 등록되지 않았다: ${identity(domain, mission ?? '*')}`);
    }
    if (available.length > 1) {
      throw new Error(`domain mission이 모호하다: ${domain} (${available.map(([key]) => key).join(', ')})`);
    }
    const [key, factory] = available[0]!;
    const adapter = factory();
    if (
      adapter.domain !== domain ||
      adapter.contract.domain !== domain ||
      (mission !== undefined && adapter.mission !== mission) ||
      adapter.mission !== adapter.contract.mission
    ) {
      throw new Error(
        `domain adapter identity가 다르다: ` +
          `${key}/${adapter.domain}/${adapter.mission}/${adapter.contract.domain}/${adapter.contract.mission}`,
      );
    }
    return adapter;
  }

  list(): string[] {
    return [...this.factories.keys()].sort();
  }
}

const defaultRegistry = new DomainRegistry();
defaultRegistry.register('soc', 'report', () => new SocReportDomainAdapter());
defaultRegistry.register('soc', 'investigation', () => new SocInvestigationDomainAdapter());

export function registerDomainAdapter(
  domain: string,
  mission: string,
  factory: () => DomainAdapter,
): void {
  defaultRegistry.register(domain, mission, factory);
}

export function getDomainAdapter(domain: string, mission?: string): DomainAdapter {
  return defaultRegistry.get(domain, mission);
}

export function registeredDomainAdapters(): string[] {
  return defaultRegistry.list();
}

function identity(domain: string, mission: string): string {
  return `${domain}/${mission}`;
}
