import type { Config } from './config.js';
import { checkTestWithJev, JevError } from './cloudflare-jev.js';
import type { TestCheckInput, TestCheckResult } from './types.js';

const MAX_COMMAND_LENGTH = 16_000;
const MAX_TEST_CODE_LENGTH = 64_000;
const MAX_DIFF_LENGTH = 64_000;
const MAX_CONTEXT_LENGTH = 32_000;

const SECRET_ASSIGNMENT = /((?:DB_PASSWORD|DB_USERNAME|API_TOKEN|CLOUDFLARE_API_TOKEN|APP_KEY|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|CREDENTIALS?|SECRET|PASSWORD|TOKEN)\s*[=:]\s*)([^\s,;\n]+)/giu;
const ENV_SECRET_LINE = /(^|\n)(\s*(?:DB_PASSWORD|DB_USERNAME|API_TOKEN|CLOUDFLARE_API_TOKEN|APP_KEY|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|CREDENTIALS?|SECRET|PASSWORD|TOKEN)\s*=)[^\n]*/giu;

function reviewResult(
  reason: string,
  staticFindings: string[] = [],
  errorCode?: string,
): TestCheckResult {
  return {
    ok: false,
    dangerous: null,
    allowed: false,
    needsHumanReview: true,
    decision: 'review',
    staticFindings,
    reason,
    model: 'typesafe/jev',
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function redact(value: string): string {
  return value
    .replace(ENV_SECRET_LINE, '$1$2[REDACTED]')
    .replace(SECRET_ASSIGNMENT, '$1[REDACTED]');
}

function inputText(input: TestCheckInput): string {
  return [input.command, input.testCode, input.diff, input.context]
    .filter((value): value is string => value !== undefined)
    .join('\n');
}

function hasSafeRuntimeDatabase(input: TestCheckInput): boolean {
  const database = input.runtimeDatabase;
  return database?.connection === 'sqlite'
    && database.database === ':memory:'
    && database.enforced === true;
}

function hasSafeRuntimeGuard(input: TestCheckInput): boolean {
  const cache = input.configCache;
  const guard = input.runtimeGuard;
  return hasSafeRuntimeDatabase(input)
    && cache?.clearedBeforeTest === true
    && cache.restoredAfterTest === true
    && guard?.enabled === true
    && guard.checksActualConnection === true
    && guard.rejectsPersistentDatabase === true
    && guard.rejectsFallback === true
    && input.persistentDatabaseAccess === false;
}

function hasExplicitPersistentTarget(input: TestCheckInput): boolean {
  if (input.persistentDatabaseAccess === true) {
    return true;
  }
  if (input.runtimeDatabase !== undefined) {
    return input.runtimeDatabase.connection !== 'sqlite'
      || input.runtimeDatabase.database !== ':memory:';
  }

  const context = input.context ?? '';
  return /\bDB_CONNECTION\s*=\s*(?:mysql|mariadb|pgsql|sqlsrv)\b/iu.test(context)
    || /\bDB_DATABASE\s*=\s*(?!:memory:)[^\s#]+/iu.test(context)
    || /\b(?:mysql|mariadb|postgres(?:ql)?|sqlsrv):\/\//iu.test(context);
}

function hasUnconfirmedPersistentTarget(input: TestCheckInput): boolean {
  if (hasSafeRuntimeGuard(input) || hasExplicitPersistentTarget(input)) {
    return false;
  }
  const context = input.context ?? '';
  const sqliteMemoryConfig = /\bDB_CONNECTION\s*[=:]\s*sqlite\b/iu.test(context)
    && /\bDB_DATABASE\s*[=:]\s*:memory:/iu.test(context);
  if (sqliteMemoryConfig) {
    return false;
  }
  return /\b(?:persistent|database|DB_CONNECTION|DB_DATABASE|mysql|mariadb|pgsql|sqlsrv)\b/iu.test(context)
    || (input.runtimeDatabase !== undefined && input.persistentDatabaseAccess === undefined);
}

interface StaticRiskResult {
  findings: string[];
  blocking: string[];
}

function findStaticRisks(input: TestCheckInput): StaticRiskResult {
  const text = inputText(input);
  const findings: string[] = [];
  const blocking: string[] = [];
  const safeRuntime = hasSafeRuntimeGuard(input);
  const patterns: Array<[string, RegExp]> = [
    ['RefreshDatabase', /\bRefreshDatabase\b/u],
    ['DatabaseMigrations', /\bDatabaseMigrations\b/u],
    ['DatabaseTruncation', /\bDatabaseTruncation\b/u],
    ['migrate:fresh', /\bmigrate\s*:\s*fresh\b/iu],
    ['db:wipe', /\bdb\s*:\s*wipe\b/iu],
    ['TRUNCATE', /\bTRUNCATE\s+(?:TABLE\s+)?[A-Za-z0-9_`".]+/iu],
    ['DROP TABLE', /\bDROP\s+TABLE\b/iu],
    ['DROP DATABASE', /\bDROP\s+DATABASE\b/iu],
  ];

  for (const [name, pattern] of patterns) {
    if (pattern.test(text)) {
      if (safeRuntime && ['RefreshDatabase', 'DatabaseMigrations'].includes(name)) {
        continue;
      }
      findings.push(name);
      if (!['RefreshDatabase', 'DatabaseMigrations'].includes(name)) {
        blocking.push(name);
      }
    }
  }

  const persistentTarget = !hasSafeRuntimeGuard(input) && hasExplicitPersistentTarget(input);
  if (persistentTarget) {
    findings.push('persistent database target is not confirmed as test-only');
    blocking.push('persistent database target is not confirmed as test-only');
  } else if (hasUnconfirmedPersistentTarget(input)) {
    findings.push('persistent database target is not confirmed as test-only');
  }

  if (persistentTarget && !hasSafeRuntimeGuard(input)) {
    const traitIsPresent = findings.includes('RefreshDatabase') || findings.includes('DatabaseMigrations');
    if (traitIsPresent) {
      blocking.push('persistent database target is not confirmed as test-only');
    }
  }

  return { findings, blocking: [...new Set(blocking)] };
}

function validateInput(input: TestCheckInput): string | undefined {
  if (input.command.trim() === '') {
    return 'command must not be empty.';
  }
  if (input.command.length > MAX_COMMAND_LENGTH) {
    return `command exceeds the ${MAX_COMMAND_LENGTH}-character limit.`;
  }
  if (input.testCode !== undefined && input.testCode.length > MAX_TEST_CODE_LENGTH) {
    return `testCode exceeds the ${MAX_TEST_CODE_LENGTH}-character limit.`;
  }
  if (input.diff !== undefined && input.diff.length > MAX_DIFF_LENGTH) {
    return `diff exceeds the ${MAX_DIFF_LENGTH}-character limit.`;
  }
  if (input.context !== undefined && input.context.length > MAX_CONTEXT_LENGTH) {
    return `context exceeds the ${MAX_CONTEXT_LENGTH}-character limit.`;
  }
  return undefined;
}

function hasSufficientEnvironmentEvidence(input: TestCheckInput): boolean {
  return hasSafeRuntimeGuard(input);
}

export async function evaluateTest(
  config: Config,
  input: TestCheckInput,
): Promise<TestCheckResult> {
  const validationError = validateInput(input);
  const staticRisk = findStaticRisks(input);
  const staticFindings = staticRisk.findings;
  if (validationError !== undefined) {
    return reviewResult(validationError, staticFindings, 'INVALID_INPUT');
  }

  const safeInput: TestCheckInput = {
    command: redact(input.command),
    ...(input.testCode === undefined ? {} : { testCode: redact(input.testCode) }),
    ...(input.diff === undefined ? {} : { diff: redact(input.diff) }),
    ...(input.context === undefined ? {} : { context: redact(input.context) }),
    ...(input.runtimeDatabase === undefined ? {} : { runtimeDatabase: input.runtimeDatabase }),
    ...(input.configCache === undefined ? {} : { configCache: input.configCache }),
    ...(input.runtimeGuard === undefined ? {} : { runtimeGuard: input.runtimeGuard }),
    ...(input.persistentDatabaseAccess === undefined ? {} : { persistentDatabaseAccess: input.persistentDatabaseAccess }),
  };

  try {
    const response = await checkTestWithJev(config, {
      ...safeInput,
      staticFindings,
    });
    const dangerous = response.answers?.test_dangerous?.noul ?? response.answers?.command_dangerous?.noul;
    if (dangerous === undefined) {
      return reviewResult('Jev did not return a dangerousness score.', staticFindings, 'JEV_INVALID_RESPONSE');
    }

    if (staticRisk.blocking.length > 0 || dangerous >= 0.8) {
      return {
        ok: true,
        dangerous,
        allowed: false,
        needsHumanReview: false,
        decision: 'deny',
        staticFindings,
        reason: staticFindings.length > 0
          ? 'Static analysis found a potentially destructive test or an unconfirmed persistent database target.'
          : 'Jev found a high probability that the test may destroy or modify existing data.',
        model: 'typesafe/jev',
      };
    }

    if (!hasSufficientEnvironmentEvidence(input) || dangerous >= 0.4) {
      return {
        ok: true,
        dangerous,
        allowed: false,
        needsHumanReview: true,
        decision: 'review',
        staticFindings,
        reason: !hasSufficientEnvironmentEvidence(input)
          ? 'The effective test database and configuration cache state were not sufficiently confirmed.'
          : 'Jev found a moderate probability that the test may be destructive and requires human review.',
        model: 'typesafe/jev',
      };
    }

    return {
      ok: true,
      dangerous,
      allowed: true,
      needsHumanReview: false,
      decision: 'allow',
      staticFindings,
      reason: 'The test environment is sufficiently isolated, no static destructive pattern was found, and Jev found no clear destructive risk.',
      model: 'typesafe/jev',
    };
  } catch (error) {
    if (error instanceof JevError) {
      return reviewResult(
        'Jev could not complete the test safety check. Human review is required before test execution.',
        staticFindings,
        error.code,
      );
    }
    return reviewResult('An unexpected error occurred during the test safety check.', staticFindings, 'INTERNAL_ERROR');
  }
}
