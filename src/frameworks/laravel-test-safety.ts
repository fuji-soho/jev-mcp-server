import type { StaticFinding, TestCheckInput } from '../types.js';

export interface LaravelSafetyContext {
  safeRuntime: boolean;
  explicitPersistentTarget: boolean;
}

/** Laravel-specific static checks kept outside the framework-neutral test checker. */
export function findLaravelTestRisks(input: TestCheckInput, text: string, context: LaravelSafetyContext): StaticFinding[] {
  const findings: StaticFinding[] = [];
  // Preserve historical detection when callers omit framework=laravel.
  if (input.framework?.trim().toLowerCase() !== 'laravel') {
    if (/\bDatabaseTruncation\b/u.test(text)) findings.push({ ruleId: 'legacy.laravel-database-truncation', category: 'database', severity: 'critical', decision: 'deny', message: 'DatabaseTruncation' });
    if (/\bmigrate\s*:\s*fresh\b/iu.test(text)) findings.push({ ruleId: 'legacy.laravel-migrate-fresh', category: 'database', severity: 'critical', decision: 'deny', message: 'migrate:fresh' });
    if (/\bdb\s*:\s*wipe\b/iu.test(text)) findings.push({ ruleId: 'legacy.laravel-db-wipe', category: 'database', severity: 'critical', decision: 'deny', message: 'db:wipe' });
  }
  if (/\b(?:RefreshDatabase|DatabaseMigrations)\b/u.test(text) && context.explicitPersistentTarget && !context.safeRuntime) {
    findings.push({ ruleId: 'laravel.persistent-database-with-reset-trait', category: 'persistent-data', severity: 'critical', decision: 'deny', message: 'RefreshDatabase' });
  } else if (/\b(?:RefreshDatabase|DatabaseMigrations)\b/u.test(text) && !context.safeRuntime) {
    findings.push({ ruleId: 'framework.database-reset-isolation-unknown', category: 'environment-isolation', severity: 'medium', decision: 'review', message: 'Database-resetting test behavior is present but isolation was not confirmed.' });
  }
  return findings;
}
