/**
 * Record+Continue pattern for non-safety quality issues across all domains.
 *
 * Instead of throwing on QUALITY inconsistencies (quote mismatches, claim scope errors,
 * evidence locator drift, etc.), functions record issues here and auto-correct where
 * possible. The final verification phase makes the judgment; mid-pipeline throws are
 * reserved for genuine safety/security violations.
 */

export interface QualityIssue {
  /** Domain that detected the issue. */
  domain: string;
  /** Discriminator key, e.g. 'quote-mismatch', 'claim-scope-mismatch'. */
  type: string;
  /** Pipeline phase that detected the issue. */
  phase: string;
  /** warn = auto-corrected or informational; error = could not auto-correct. */
  severity: 'warn' | 'error';
  /** Human-readable description of what was wrong. */
  detail: string;
  /** What was auto-corrected, if anything. */
  correction?: string;
}

export class QualityIssueCollector {
  readonly issues: QualityIssue[] = [];

  record(issue: QualityIssue): void {
    this.issues.push(issue);
    const prefix = issue.correction
      ? `[${issue.domain}:quality] auto-corrected (${issue.type})`
      : `[${issue.domain}:quality] recorded (${issue.type})`;
    console.warn(`${prefix}: ${issue.detail}${issue.correction ? ` → ${issue.correction}` : ''}`);
  }

  hasErrors(): boolean {
    return this.issues.some((issue) => issue.severity === 'error');
  }

  toUnresolved(): string[] {
    return this.issues.map((issue) =>
      `[quality:${issue.type}] ${issue.detail}${issue.correction ? ` (auto-corrected: ${issue.correction})` : ''}`,
    );
  }
}
