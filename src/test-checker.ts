import { evaluationIdentity, isEvaluationCacheReusable, isVersionedModel, type Config } from './config.js';
import { checkTestWithJev, JevError, validateTestRequestSize, type TestSafetyState } from './cloudflare-jev.js';
import { findPolicyMatches, loadEffectiveTestPolicies, strictestDecision } from './policy.js';
import { assessSafetyProfile, ENVIRONMENT_VERIFIER_VERSION, validateExecutionSelection, type ExecutionSelectionResult, type SafetyProfileResult } from './test-safety-profile.js';
import type { Decision, EnvironmentAssessment, PolicyFinding, RiskCategory, StaticFinding, TestCheckInput, TestCheckResult, TestFileError, TestFinding } from './types.js';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDatabase } from './storage/sqlite.js';
import { insertAudit } from './storage/audit-log.js';
import { lookupAllow, upsertCache, type CacheKey } from './storage/fingerprint-cache.js';
import { bindHumanReviewModel, createOrGetHumanReview, lookupApprovedHumanReview, markHumanReviewUsed, type HumanReviewKey } from './storage/human-review.js';
import { buildFingerprint, canonicalJson, EVALUATOR_VERSION, fileDigest, projectId, relativeTarget, readTestFile, resolveTestRoot, sha256, testInputIdentity, type TestFileIdentity, type TestFileResolution } from './safety-fingerprint.js';
import { logEvent } from './logger.js';
import { createOrGetEnvironmentReview, lookupEnvironmentApproval, type EnvironmentApprovalKey } from './storage/environment-approval.js';
import { issueExecutionTicket } from './storage/execution-ticket.js';
import { findLaravelTestRisks } from './frameworks/laravel-test-safety.js';
import { usesExecutionProfile } from './execution-profile.js';
import { evaluateTestExecution } from './test-execution-checker.js';
import { buildCommandStaticFindings } from './command-checker.js';

const MAX_COMMAND_LENGTH = 16_000;
const MAX_TEST_CODE_LENGTH = 64_000;
const MAX_DIFF_LENGTH = 64_000;
const MAX_CONTEXT_LENGTH = 32_000;
const MAX_FIELD_LENGTH = 4_000;
const SEVERITY_SCORE = { low: 0.25, medium: 0.5, high: 0.8, critical: 1 } as const;
const HUMAN_REVIEW_TTL_SECONDS = 60 * 60;
const ENVIRONMENT_REVIEW_TTL_SECONDS = 60 * 60;
const EXECUTION_TICKET_TTL_SECONDS = 5 * 60;

function reviewResult(reason: string, staticFindings: string[] = [], errorCode?: string, details: Partial<TestCheckResult> = {}): TestCheckResult {
  return { ok: false, dangerous: null, allowed: false, needsHumanReview: true, decision: 'review', categories: [], riskScore: null, policyVersion: 'unavailable', staticFindings, reason, model: 'typesafe/jev', ...details, ...(errorCode === undefined ? {} : { errorCode }) };
}

function inputErrorResult(reason: string, errorCode: string, fileErrors?: TestFileError[]): TestCheckResult {
  return { ...reviewResult(reason, [], errorCode), needsHumanReview: false, ...(fileErrors === undefined ? {} : { fileErrors }) };
}

export function redactTestText(value: string): string {
  return value
    .replace(/(["']?(?:DB_PASSWORD|DB_USERNAME|API_TOKEN|CLOUDFLARE_API_TOKEN|APP_KEY|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CLIENT[_-]?SECRET|CREDENTIALS?|SECRET|PASSWORD|TOKEN)["']?\s*(?:=>|=|:)\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;\n]+)/giu, '$1[REDACTED]')
    .replace(/(--?(?:token|password|secret|api[-_]?key|access[-_]?key|private[-_]?key)(?:=|\s+))([^\s,;&]+)/giu, '$1[REDACTED]');
}
const redact = redactTestText;

function inputText(input: TestCheckInput): string {
  return [input.command, input.testCode, input.diff, input.cwd, input.environment, input.framework, input.context, input.execution === undefined ? undefined : canonicalJson(input.execution)]
    .filter((value): value is string => value !== undefined).join('\n');
}

function validateInput(input: TestCheckInput): string | undefined {
  if (input.command.trim() === '') return 'command must not be empty.';
  if (input.command.length > MAX_COMMAND_LENGTH) return `command exceeds the ${MAX_COMMAND_LENGTH}-character limit.`;
  if (input.testCode !== undefined && input.testCode.length > MAX_TEST_CODE_LENGTH) return `testCode exceeds the ${MAX_TEST_CODE_LENGTH}-character limit.`;
  if (input.diff !== undefined && input.diff.length > MAX_DIFF_LENGTH) return `diff exceeds the ${MAX_DIFF_LENGTH}-character limit.`;
  if (input.context !== undefined && input.context.length > MAX_CONTEXT_LENGTH) return `context exceeds the ${MAX_CONTEXT_LENGTH}-character limit.`;
  for (const [name, value] of [['cwd', input.cwd], ['framework', input.framework]] as const) if (value !== undefined && value.length > MAX_FIELD_LENGTH) return `${name} exceeds the ${MAX_FIELD_LENGTH}-character limit.`;
  return undefined;
}

function legacySafeRuntime(input: TestCheckInput): boolean {
  const database = input.runtimeDatabase;
  const cache = input.configCache;
  const guard = input.runtimeGuard;
  return database?.connection === 'sqlite' && database.database === ':memory:' && database.enforced === true
    && cache?.clearedBeforeTest === true && cache.restoredAfterTest === true
    && guard?.enabled === true && guard.checksActualConnection === true
    && guard.rejectsPersistentDatabase === true && guard.rejectsFallback === true && input.persistentDatabaseAccess === false;
}

function structuredSafeRuntime(input: TestCheckInput): boolean {
  const isolation = input.isolation;
  const runtime = input.runtime;
  const noPersistentStorage = runtime?.persistentStorageAccess === false && input.persistentDatabaseAccess !== true;
  const noProduction = runtime?.productionAccess === false;
  const isolatedResources = isolation?.ephemeralDatabase === true || (isolation?.temporaryFilesystem === true && isolation?.mockedExternalServices === true);
  return noPersistentStorage && noProduction && isolatedResources === true;
}

function hasSafeRuntime(input: TestCheckInput): boolean { return legacySafeRuntime(input) || structuredSafeRuntime(input); }

function hasExplicitPersistentTarget(input: TestCheckInput): boolean {
  if (input.persistentDatabaseAccess === true || input.runtime?.persistentStorageAccess === true) return true;
  const context = input.context ?? '';
  if (input.runtimeDatabase !== undefined) return input.runtimeDatabase.connection !== 'sqlite' || input.runtimeDatabase.database !== ':memory:';
  return /\bDB_CONNECTION\s*=\s*(?:mysql|mariadb|pgsql|sqlsrv)\b/iu.test(context)
    || /\bDB_DATABASE\s*=\s*(?!:memory:)[^\s#]+/iu.test(context)
    || /\b(?:mysql|mariadb|postgres(?:ql)?|sqlsrv):\/\//iu.test(context)
    || /\b(?:production|persistent|real)\s+(?:database|db)\b/iu.test(context);
}

export function customFindings(input: TestCheckInput, text = inputText(input), executionApproved = false): StaticFinding[] {
  const findings: StaticFinding[] = [];
  const safeRuntime = executionApproved || hasSafeRuntime(input);
  const explicitPersistentTarget = hasExplicitPersistentTarget(input);
  findings.push(...findLaravelTestRisks(input, text, { safeRuntime, explicitPersistentTarget }));
  if (/\bDROP\s+DATABASE\b/iu.test(text)) findings.push({ ruleId: 'legacy.drop-database', category: 'database', severity: 'critical', decision: 'deny', message: 'DROP DATABASE' });
  if (explicitPersistentTarget && !safeRuntime) findings.push({ ruleId: 'generic.persistent-target-unknown', category: 'persistent-data', severity: 'critical', decision: 'deny', message: 'persistent database target is not confirmed as test-only' });
  if (input.environment === 'production' || input.runtime?.productionAccess === true) findings.push({ ruleId: 'context.production-test', category: 'production-impact', severity: 'high', decision: 'review', message: 'The test may run against a production environment.' });
  if (input.runtime?.networkAccess === true) findings.push({ ruleId: 'context.network-access', category: 'network', severity: 'medium', decision: 'review', message: 'The test has network access and external side effects were not necessarily mocked.' });
  if (input.runtime?.credentialAccess === true) findings.push({ ruleId: 'context.credential-access', category: 'credential', severity: 'high', decision: 'review', message: 'The test may use real credentials.' });
  if (findings.every((finding) => finding.decision !== 'deny') && !/\b(?:DROP\s+DATABASE|DROP\s+TABLE|TRUNCATE|migrate\s*:\s*fresh|db\s*:\s*wipe)\b/iu.test(text) && !safeRuntime && input.isolation === undefined && input.runtime === undefined) findings.push({ ruleId: 'generic.isolation-unknown', category: 'environment-isolation', severity: 'medium', decision: 'review', message: 'Test resource isolation was not confirmed.' });
  return findings;
}

function toTestFindings(staticFindings: StaticFinding[], policyFindings: PolicyFinding[]): TestFinding[] {
  return [
    ...staticFindings.map((finding) => ({ ...finding, source: 'static' as const })),
    ...policyFindings.map((finding) => ({ ruleId: finding.rule, source: finding.source, category: finding.category, severity: finding.severity, decision: finding.decision, message: finding.reason, ...(finding.file === undefined ? {} : { file: finding.file }) })),
  ];
}

function scoring(findings: TestFinding[], dangerous: number): { risks: Partial<Record<RiskCategory, number>>; riskScore: number; categories: RiskCategory[] } {
  const risks: Partial<Record<RiskCategory, number>> = {};
  for (const finding of findings) risks[finding.category] = Math.max(risks[finding.category] ?? 0, SEVERITY_SCORE[finding.severity]);
  if (dangerous > 0) risks.irreversibility = Math.max(risks.irreversibility ?? 0, dangerous);
  return { risks, riskScore: Number(Math.max(dangerous, ...Object.values(risks), 0).toFixed(3)), categories: [...new Set(findings.map((finding) => finding.category))] };
}

function safeInput(input: TestCheckInput): TestCheckInput {
  return { command: redact(input.command), ...(input.testCode === undefined ? {} : { testCode: redact(input.testCode) }), ...(input.diff === undefined ? {} : { diff: redact(input.diff) }), ...(input.cwd === undefined ? {} : { cwd: redact(input.cwd) }), ...(input.environment === undefined ? {} : { environment: input.environment }), ...(input.framework === undefined ? {} : { framework: input.framework }), ...(input.context === undefined ? {} : { context: redact(input.context) }), ...(input.isolation === undefined ? {} : { isolation: input.isolation }), ...(input.runtime === undefined ? {} : { runtime: input.runtime }), ...(input.runtimeDatabase === undefined ? {} : { runtimeDatabase: input.runtimeDatabase }), ...(input.configCache === undefined ? {} : { configCache: input.configCache }), ...(input.runtimeGuard === undefined ? {} : { runtimeGuard: input.runtimeGuard }), ...(input.persistentDatabaseAccess === undefined ? {} : { persistentDatabaseAccess: input.persistentDatabaseAccess }), ...(input.safetyProfilePath === undefined ? {} : { safetyProfilePath: redact(input.safetyProfilePath) }), ...(input.execution === undefined ? {} : { execution: input.execution }) };
}

function sharedSafetyFiles(root: string, includeProfile = true): Array<{ key: string; digest: string; bytes: number }> {
  const candidates = ['tests/TestCase.php', 'test-safe.php', 'phpunit.xml', 'phpunit.xml.dist', 'package.json', 'pyproject.toml', 'pytest.ini', 'vitest.config.ts', 'vitest.config.js', '.jev/test-safety.json'];
  return candidates.filter(file => includeProfile || file !== '.jev/test-safety.json').map((file) => fileDigest(root, file)).filter((item): item is { key: string; digest: string; bytes: number } => item !== undefined);
}

async function evaluateTestSingle(config: Config, input: TestCheckInput, targetKey = 'test', createTicket = true, fileIdentity?: TestFileIdentity, preparedSafety?: SafetyProfileResult): Promise<TestCheckResult> {
  const evaluation = { jevProvider: config.provider, requestedModel: config.requestedModel } as const;
  const modelVersion = evaluationIdentity(config);
  const cacheReusable = isEvaluationCacheReusable(config);
  const validationError = validateInput(input);
  const safety = preparedSafety ?? assessSafetyProfile(input);
  let policies;
  try { policies = loadEffectiveTestPolicies(safety.policyRoot ?? input.cwd, input.framework); } catch { return reviewResult('The test safety policy could not be loaded. Human review is required.', [], 'POLICY_ERROR'); }
  const policyMatches = findPolicyMatches(policies, inputText(input));
  const custom = customFindings(input, inputText(input), safety.executionApproved);
  let staticFindings = [...policyMatches.findings, ...custom];
  const policyFindings = policyMatches.policyFindings;
  for (const file of safety.relatedCode?.files ?? []) {
    const matches = findPolicyMatches(policies, file.content);
    staticFindings.push(...[...matches.findings, ...customFindings(input, file.content, safety.executionApproved)].map((finding) => ({ ...finding, file: file.key })));
    policyFindings.push(...matches.policyFindings.map((finding) => ({ ...finding, file: file.key })));
  }
  let testFindings = toTestFindings(staticFindings, policyFindings);
  let messages = staticFindings.map((finding) => finding.message);
  let staticDecision = strictestDecision(staticFindings.map((finding) => finding.decision).concat(policyFindings.map((finding) => finding.decision)));
  let initialDetails = { policyFindings, policyVersion: policies.version, policiesApplied: policies.policies.map((policy) => policy.version), findings: testFindings, safetyProfile: safety.assessment };
  if (validationError !== undefined && staticDecision !== 'deny') return reviewResult(validationError, messages, 'INVALID_INPUT', initialDetails);
  const root = (() => { try { return realpathSync(resolve(input.cwd ?? process.cwd())); } catch { return resolve(input.cwd ?? process.cwd()); } })();
  const pid = projectId(root);
  const safe = safeInput(input);
  const executionSelection: ExecutionSelectionResult = safety.profileV2 === undefined
    ? { valid: true, runnerMatched: true, selectorsAllowed: true }
    : validateExecutionSelection(root, safety.profileV2, input.execution, input.testFiles, input.command, input.framework, input.environment);
  const sharedFiles = sharedSafetyFiles(root, !safety.dbRegistered);
  const dependencyFingerprint = safety.assessment.dependencyFingerprint ?? sha256(canonicalJson(sharedFiles));
  const contextHash = sha256(canonicalJson({ shared: { safety: safety.jevContext, policyVersion: policies.version, policyHash: policies.hash, files: sharedFiles, dependencyFingerprint }, runtime: input.runtime, isolation: input.isolation, database: input.runtimeDatabase, configCache: input.configCache, guard: input.runtimeGuard }));
  const runtimeHash = sha256(canonicalJson({ runtime: input.runtime, isolation: input.isolation, database: input.runtimeDatabase, configCache: input.configCache, guard: input.runtimeGuard, persistentDatabaseAccess: input.persistentDatabaseAccess }));
  const testSpecific = testInputIdentity(input, fileIdentity, safety.profileV2 !== undefined || safety.executionApproved === true);
  const fingerprint = buildFingerprint({ projectId: pid, targetType: 'test-file', targetKey, testSpecific, sharedContext: { safety: safety.jevContext, policyHash: policies.hash, profile: safety.assessment, files: sharedFiles, dependencyFingerprint }, policyHash: policies.hash, contextHash, safetyProfileHash: safety.assessment.profileDigest, runtimeHash, modelVersion, evaluatorVersion: EVALUATOR_VERSION });
  const cacheKey: CacheKey = { projectId: pid, targetType: 'test-file', targetKey, fingerprint, policyHash: policies.hash, contextHash, safetyProfileHash: safety.assessment.profileDigest, runtimeHash, modelVersion, evaluatorVersion: EVALUATOR_VERSION };
  const humanReviewContext: Omit<HumanReviewKey, 'actualModel'> = {
    projectId: pid, targetType: 'test-file', targetKey, fingerprint,
    commandHash: sha256(input.command), testFilesHash: sha256(canonicalJson([targetKey])), cwdHash: sha256(root),
    policyHash: policies.hash, contextHash, runtimeHash,
    ...(safety.assessment.profileDigest === undefined ? {} : { safetyProfileHash: safety.assessment.profileDigest }),
  };
  let db;
  try { db = openDatabase(); } catch { db = undefined; }
  let environmentAssessment: EnvironmentAssessment = { status: 'not-applicable', fingerprintMatched: false, reapprovalRequired: false };
  let environmentApprovalId: string | undefined;
  let effectiveSafetyAssessment = safety.assessment;
  if (safety.profileV2 !== undefined) {
    const environmentFingerprint = safety.assessment.environmentFingerprint;
    const profileDigest = safety.assessment.profileDigest;
    const scopeJson = safety.environmentScopeJson;
    const environmentScope = scopeJson === undefined ? undefined : JSON.parse(scopeJson) as Record<string, unknown>;
    environmentAssessment = { status: 'missing', ...(environmentFingerprint === undefined ? {} : { environmentFingerprint }), fingerprintMatched: false, reapprovalRequired: true, ...(environmentScope === undefined ? {} : { scope: environmentScope }) };
    const executionAssessment = { runnerMatched: executionSelection.runnerMatched, selectorsAllowed: executionSelection.selectorsAllowed, ...(executionSelection.executionFingerprint === undefined ? {} : { executionFingerprint: executionSelection.executionFingerprint }), ...(executionSelection.reason === undefined ? {} : { reason: executionSelection.reason }) };
    const v2Details = { ...initialDetails, environmentAssessment, executionAssessment, codeAssessment: { status: 'not-evaluated' as const, ...(safety.relatedCode?.status === 'incomplete' ? {} : { dependencyFingerprint }) } };
    if (staticDecision === 'deny') return { ...v2Details, ...evaluation, ...scoring(testFindings, 1), ok: true, dangerous: 1, allowed: false, needsHumanReview: false, decision: 'deny', staticFindings: messages, model: 'typesafe/jev', reason: 'Static policy denied the test before environment approval could be considered.' };
    if (!executionSelection.valid) return reviewResult(executionSelection.reason ?? 'The execution selection is outside the approved runner scope.', messages, 'INVALID_EXECUTION_SELECTION', v2Details);
    if (environmentFingerprint === undefined || profileDigest === undefined || scopeJson === undefined) return reviewResult('The environment fingerprint is incomplete.', messages, 'INVALID_SAFETY_PROFILE', { ...v2Details, environmentAssessment: { ...environmentAssessment, status: 'invalid' } });
    if (!db) return reviewResult('The Environment Approval store is unavailable.', messages, 'ENVIRONMENT_APPROVAL_STORE_ERROR', v2Details);
    const environmentKey: EnvironmentApprovalKey = { projectId: pid, profileDigest, environmentFingerprint, scopeJson, verifierVersion: ENVIRONMENT_VERIFIER_VERSION };
    const now = new Date();
    const approved = lookupEnvironmentApproval(db, environmentKey, now.toISOString(), input.environmentApprovalId);
    if (!approved) {
      if (safety.relatedCode?.status === 'incomplete') return reviewResult(safety.relatedCode.reason, messages, 'RELATED_CODE_REVIEW_INCOMPLETE', v2Details);
      if (input.environmentApprovalId !== undefined) return reviewResult('The requested Environment Approval does not match the current project and environment fingerprint.', messages, 'ENVIRONMENT_APPROVAL_MISMATCH', { ...v2Details, environmentAssessment: { ...environmentAssessment, status: 'changed', approvalId: input.environmentApprovalId } });
      const pendingExpiresAt = new Date(now.getTime() + ENVIRONMENT_REVIEW_TTL_SECONDS * 1000).toISOString();
      const pending = createOrGetEnvironmentReview(db, environmentKey, now.toISOString(), pendingExpiresAt);
      return reviewResult('Human approval is required for this execution environment. Test code approval was not reused.', messages, undefined, { ...v2Details, environmentReviewId: pending.approvalId, environmentAssessment: { ...environmentAssessment, status: 'pending', approvalId: pending.approvalId } });
    }
    environmentApprovalId = approved.approvalId;
    environmentAssessment = { status: 'approved', approvalId: approved.approvalId, environmentFingerprint, fingerprintMatched: true, reapprovalRequired: false, ...(environmentScope === undefined ? {} : { scope: environmentScope }) };
    effectiveSafetyAssessment = { ...safety.assessment, status: 'verified', fingerprintMatched: true, runtimeMatched: true };
    const databasePolicy = safety.profileV2.resources.database.policy;
    const databaseResetIsolated = databasePolicy === 'sqlite-memory' || databasePolicy === 'temporary-only';
    staticFindings = staticFindings.filter((finding) => (finding.ruleId !== 'framework.database-reset-isolation-unknown' || !databaseResetIsolated) && finding.ruleId !== 'generic.isolation-unknown');
    testFindings = toTestFindings(staticFindings, policyFindings);
    messages = staticFindings.map((finding) => finding.message);
    initialDetails = { policyFindings, policyVersion: policies.version, policiesApplied: policies.policies.map((policy) => policy.version), findings: testFindings, safetyProfile: effectiveSafetyAssessment };
    staticDecision = strictestDecision(staticFindings.map((finding) => finding.decision).concat(policyFindings.map((finding) => finding.decision)));
  }
  const details = {
    ...initialDetails,
    codeAssessment: { status: 'not-evaluated' as const, ...(safety.relatedCode?.status === 'incomplete' ? {} : { fingerprint, dependencyFingerprint }) },
    safetyProfile: effectiveSafetyAssessment,
    environmentAssessment,
    executionAssessment: {
      runnerMatched: executionSelection.runnerMatched,
      selectorsAllowed: executionSelection.selectorsAllowed,
      ...(executionSelection.executionFingerprint === undefined ? {} : { executionFingerprint: executionSelection.executionFingerprint }),
    },
  };
  const requestId = randomUUID();
  const audit = (result: TestCheckResult, cacheStatus: 'disabled'|'miss'|'hit'|'error', jevDecision?: Decision, save = false): void => {
    if (!db) return;
    try { db.exec('BEGIN'); insertAudit(db, { requestId, projectId: pid, toolName: 'jev_check_test', targetType: 'test-file', targetKey, fingerprint, cacheStatus, staticDecision, jevDecision, finalDecision: result.decision, allowed: result.allowed, needsHumanReview: result.needsHumanReview, policyHash: policies.hash, contextHash, safetyProfileHash: safety.assessment.profileDigest, runtimeHash, modelVersion, jevProvider: config.provider, requestedModel: config.requestedModel, actualModel: result.actualModel, evaluatorVersion: EVALUATOR_VERSION, reason: result.reason }); if (save && result.decision === 'allow' && cacheReusable && result.actualModel === config.requestedModel) upsertCache(db, cacheKey, result.decision, true, new Date().toISOString(), result.actualModel); db.exec('COMMIT'); } catch { try { db.exec('ROLLBACK'); } catch { /* best effort */ } logEvent('audit_persistence_error', { tool: 'jev_check_test' }); }
  };
  const issueReview = (result: TestCheckResult, humanReviewKey: HumanReviewKey): TestCheckResult => {
    if (!db) return result;
    try {
      const now = new Date();
      const expires = new Date(now.getTime() + HUMAN_REVIEW_TTL_SECONDS * 1000).toISOString();
      const review = createOrGetHumanReview(db, humanReviewKey, now.toISOString(), expires);
      return { ...result, reviewId: review.reviewId };
    } catch {
      logEvent('human_review_persistence_error', { tool: 'jev_check_test' });
      return result;
    }
  };
  const attachTicket = (result: TestCheckResult): TestCheckResult => {
    if (!createTicket || safety.profileV2 === undefined || !db || environmentApprovalId === undefined || safety.assessment.environmentFingerprint === undefined || executionSelection.executionFingerprint === undefined) return result;
    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + EXECUTION_TICKET_TTL_SECONDS * 1000).toISOString();
      const ticket = issueExecutionTicket(db, { approvalId: environmentApprovalId, projectId: pid, environmentFingerprint: safety.assessment.environmentFingerprint, codeFingerprint: fingerprint, executionFingerprint: executionSelection.executionFingerprint }, now.toISOString(), expiresAt);
      return { ...result, executionAssessment: { ...result.executionAssessment, runnerMatched: true, selectorsAllowed: true, executionFingerprint: executionSelection.executionFingerprint, ticket: ticket.token, ticketExpiresAt: ticket.expiresAt } };
    } catch { return { ...result, allowed: false, needsHumanReview: true, decision: 'review', errorCode: 'EXECUTION_TICKET_ERROR', reason: 'An execution ticket could not be issued.' }; }
  };
  if (staticDecision === 'deny') {
    const result: TestCheckResult = { ...details, ...evaluation, ...scoring(testFindings, 1), codeAssessment: { status: 'not-evaluated', fingerprint, dependencyFingerprint }, ok: true, dangerous: 1, allowed: false, needsHumanReview: false, decision: 'deny', staticFindings: messages, model: 'typesafe/jev', reason: 'Static policy denied the test before Jev evaluation.' };
    audit(result, 'disabled');
    return result;
  }
  if (safety.relatedCode?.status === 'incomplete') {
    const result = reviewResult(safety.relatedCode.reason, messages, 'RELATED_CODE_REVIEW_INCOMPLETE', { ...details, ...evaluation });
    audit(result, 'disabled');
    return result;
  }
  const state: TestSafetyState = { ...safe, safetyProfile: effectiveSafetyAssessment, safetyProfileContext: { ...safety.jevContext, environmentApprovalId: environmentApprovalId ?? null, environmentApproved: environmentApprovalId !== undefined }, staticFindings: messages,
    ...(safety.relatedCode === undefined ? {} : { relatedCode: safety.relatedCode.files.map((file) => ({ file: file.key, content: redact(file.content) })) }),
  };
  try { validateTestRequestSize(config, state); }
  catch (error) {
    const result = reviewResult(error instanceof JevError ? error.message : 'The related code request could not be prepared.', messages, 'RELATED_CODE_REVIEW_INCOMPLETE', { ...details, ...evaluation });
    audit(result, 'disabled');
    return result;
  }
  if (cacheReusable && validationError === undefined && staticDecision === 'allow' && db) {
    try { const hit = lookupAllow(db, cacheKey); if (hit) { const result: TestCheckResult = attachTicket({ ...details, ...evaluation, ...(hit.actualModel === undefined ? {} : { actualModel: hit.actualModel }), ...scoring(testFindings, 0), codeAssessment: { status: 'cache-hit', fingerprint, dependencyFingerprint }, ok: true, dangerous: 0, allowed: true, needsHumanReview: false, decision: 'allow', staticFindings: messages, model: 'typesafe/jev', reason: 'An unchanged allow decision was reused from the Safety Fingerprint Cache.' }); audit(result, 'hit'); return result; } } catch { /* cache is unavailable; continue with Jev */ }
  }
  try {
    const response = await checkTestWithJev(config, state);
    const dangerous = response.answers?.test_dangerous?.noul ?? response.answers?.command_dangerous?.noul;
    if (dangerous === undefined) return reviewResult('Jev did not return a dangerousness score.', messages, 'JEV_INVALID_RESPONSE', details);
    const scored = scoring(testFindings, dangerous);
    const staticDecision = strictestDecision(staticFindings.map((finding) => finding.decision).concat(policyFindings.map((finding) => finding.decision)));
    const jevDecision: Decision = dangerous >= 0.8 ? 'deny' : dangerous >= 0.4 ? 'review' : 'allow';
    const profileDecision: Decision = safety.profileV2 !== undefined ? 'allow' : safety.assessment.status === 'verified' ? 'allow' : safety.assessment.status === 'absent' ? (hasSafeRuntime(input) ? 'allow' : 'review') : 'review';
    const decision = strictestDecision([staticDecision, jevDecision, profileDecision]);
    const common = { ...details, ...evaluation, actualModel: response.model, codeAssessment: { status: 'evaluated' as const, fingerprint, dependencyFingerprint }, ok: true, dangerous, ...scored, staticFindings: messages, model: 'typesafe/jev' as const };
    if (decision === 'deny') { const result = { ...common, allowed: false, needsHumanReview: false, decision, reason: 'Static or contextual analysis found a potentially destructive test operation or persistent resource target.' }; audit(result, 'miss', jevDecision, false); return result; }
    if (decision === 'review') {
      const reason = effectiveSafetyAssessment.status === 'changed' || effectiveSafetyAssessment.status === 'unverified' || effectiveSafetyAssessment.status === 'invalid'
        ? 'The Safety Profile is not verified for the current files or runtime context.'
        : 'Test isolation or external side-effect safety could not be sufficiently confirmed.';
      const pendingResult = { ...common, allowed: false, needsHumanReview: true, decision, reason };
      if (!isVersionedModel(response.model)) {
        const result = { ...pendingResult, errorCode: 'JEV_MODEL_ID_UNVERIFIED', reason: 'The API did not identify a versioned actual model. Human Approval cannot be safely matched; use a provider that reports a jev-X.Y.Z model ID.' };
        audit(result, 'miss', jevDecision);
        return result;
      }
      const humanReviewKey = bindHumanReviewModel(humanReviewContext, response.model);
      if (db) {
        const approved = lookupApprovedHumanReview(db, humanReviewKey, new Date().toISOString());
        if (approved) {
          const result = attachTicket({ ...common, allowed: true, needsHumanReview: false, decision: 'allow' as const, reason: 'A valid Human Approval matches the current Safety Fingerprint and all safety context.' });
          markHumanReviewUsed(db, approved.reviewId, new Date().toISOString());
          audit(result, 'miss', jevDecision, false);
          return result;
        }
      }
      const result = issueReview(pendingResult, humanReviewKey);
      audit(result, 'miss', jevDecision, false);
      return result;
    }
    const result = attachTicket({ ...common, allowed: true, needsHumanReview: false, decision, reason: effectiveSafetyAssessment.status === 'verified'
      ? 'The verified Safety Profile matches the current files and runtime context, and no new risk was detected.'
      : 'The test appears isolated, no destructive static finding was detected, and Jev found no clear high-risk behavior.' }); audit(result, 'miss', jevDecision, true); return result;
  } catch (error) {
    if (error instanceof JevError) { const result = reviewResult('Jev could not complete the test safety check. Human review is required before test execution.', messages, error.code, { ...details, ...evaluation }); audit(result, 'miss'); return result; }
    const result = reviewResult('An unexpected error occurred during the test safety check.', messages, 'INTERNAL_ERROR', { ...details, ...evaluation }); audit(result, 'error'); return result;
  }
}

export async function evaluateTest(config: Config, input: TestCheckInput): Promise<TestCheckResult> {
  let registeredProject = false, legacyExecutionHistory = false;
  try {
    const root = realpathSync(resolve(input.cwd ?? process.cwd()));
    const db = openDatabase();
    registeredProject = db.prepare('SELECT 1 FROM test_execution_conditions WHERE project_id=? LIMIT 1').get(projectId(root)) !== undefined;
    legacyExecutionHistory = input.safetyProfilePath !== undefined && db.prepare("SELECT 1 FROM test_execution_approvals WHERE project_id=? AND source_kind='profile' AND profile_path=? LIMIT 1").get(projectId(root), relativeTarget(root,resolve(input.safetyProfilePath)) ?? '') !== undefined;
  } catch (error) {
    // A registration store failure cannot silently choose the legacy evidence-only evaluator.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { ...reviewResult('Execution registration storage could not be read. Correct the database and recheck.', [], 'EXECUTION_STORE_ERROR'), needsHumanReview:false };
  }
  // Normal Laravel/Composer/container execution never probes an implicit Profile file.
  const explicitLegacy = input.safetyProfilePath !== undefined || input.execution !== undefined || input.environmentApprovalId !== undefined;
  if (input.executionConditions || input.executionConditionsId || (!explicitLegacy && registeredProject) || (!explicitLegacy && (input.executionApprovalId || input.framework === 'laravel'
    || /(?:^|[ /])(?:composer|podman|docker)(?:\s|$)/u.test(input.command)))) return evaluateTestExecution(config,input);
  if (input.safetyProfilePath && (legacyExecutionHistory || usesExecutionProfile(input))) return evaluateTestExecution(config,input);
  // Legacy inputs retain their workflows, but command Policy prohibitions apply inside the test gate too.
  try {
    const command = buildCommandStaticFindings(input, true);
    if (command.findings.some(f => f.decision === 'deny')) return { ...reviewResult('Command policy denied this test execution.', [...command.findings, ...customFindings(input)].map(f => f.message), 'STATIC_DENY'), ok: true, dangerous: 1, riskScore: 1, decision: 'deny', needsHumanReview: false, policyVersion: command.policyVersion, policyFindings: command.policyFindings };
  } catch { return { ...reviewResult('Command safety policy could not be loaded.', [], 'POLICY_ERROR'), needsHumanReview: false }; }
  const result = await evaluateTestCode(config, input);
  const command = buildCommandStaticFindings(input, true);
  if (result.decision !== 'deny' && command.policyFindings.some(f => f.source === 'builtin' && f.decision === 'review')) return { ...result, decision: 'review', allowed: false, needsHumanReview: false,
    errorCode: 'COMMAND_POLICY_REVIEW', reason: 'Command policy review is unresolved. Use Profile v3 for a separately scoped execution review.',
    policyFindings: [...(result.policyFindings ?? []), ...command.policyFindings],
    reviewReasons: [{ kind: 'command-risk', approvable: false, message: 'Command Policy review requires a supported execution workflow.' }] };
  return result;
}

export async function evaluateTestCode(config: Config, input: TestCheckInput, preparedSafety?: SafetyProfileResult, preparedFiles?: TestFileResolution[]): Promise<TestCheckResult> {
  if (!input.testFiles || input.testFiles.length === 0) return evaluateTestSingle(config, input, 'test', true, undefined, preparedSafety);
  const rootResult = resolveTestRoot(input.cwd ?? process.cwd());
  if (!rootResult.ok) return inputErrorResult(rootResult.message, rootResult.code);
  const root = rootResult.root;
  const files = preparedFiles ?? input.testFiles.map((file) => readTestFile(root, file));
  const fileErrors = files.flatMap((file) => file.ok ? [] : [file.error]);
  if (fileErrors.length > 0) {
    return inputErrorResult('One or more requested test files could not be read from the MCP server filesystem.', 'TEST_FILE_VALIDATION_ERROR', fileErrors);
  }
  const results: TestCheckResult[] = [];
  const safety = preparedSafety ?? assessSafetyProfile({ ...input, cwd: root });
  for (const file of files) {
    if (!file.ok) continue;
    results.push(await evaluateTestSingle(config, { ...input, cwd: root, testCode: file.content }, file.target, false, { digest: file.digest, bytes: file.bytes }, safety));
  }
  const decision = strictestDecision(results.map((result) => result.decision));
  const first = results[0] ?? reviewResult('No test files were supplied.', [], 'INVALID_INPUT');
  const reviewIds = results.flatMap((result) => result.reviewId === undefined ? [] : [result.reviewId]);
  const categories = [...new Set(results.flatMap((result) => result.categories))];
  const riskScores = results.flatMap((result) => result.riskScore === null ? [] : [result.riskScore]);
  const dangerousScores = results.flatMap((result) => result.dangerous === null ? [] : [result.dangerous]);
  const risks: Partial<Record<RiskCategory, number>> = {};
  for (const result of results) for (const [category, score] of Object.entries(result.risks ?? {})) risks[category as RiskCategory] = Math.max(risks[category as RiskCategory] ?? 0, score);
  const staticFindings = [...new Set(results.flatMap((result) => result.staticFindings))];
  const findings = [...new Map(results.flatMap((result) => result.findings ?? []).map((finding) => [canonicalJson(finding), finding])).values()];
  const policyFindings = [...new Map(results.flatMap((result) => result.policyFindings ?? []).map((finding) => [canonicalJson(finding), finding])).values()];
  const policiesApplied = [...new Set(results.flatMap((result) => result.policiesApplied ?? []))];
  let aggregate: TestCheckResult = {
    ...first, ok: results.every((result) => result.ok), dangerous: dangerousScores.length === 0 ? null : Math.max(...dangerousScores),
    allowed: decision === 'allow' && results.every((result) => result.allowed), needsHumanReview: results.some((result) => result.needsHumanReview), decision,
    categories, riskScore: riskScores.length === 0 ? null : Math.max(...riskScores), risks,
    staticFindings, findings, policyFindings, policyVersion: results.find((result) => result.policyVersion !== 'unavailable')?.policyVersion ?? 'unavailable', policiesApplied,
    reason: results.length === 1 ? first.reason : `Evaluated ${results.length} test files independently; aggregate decision is ${decision}.`,
    ...(reviewIds.length === 0 ? {} : { reviewIds, ...(reviewIds.length === 1 ? { reviewId: reviewIds[0] } : {}) }),
  };
  if (results.length > 1 && preparedSafety?.executionApproved) {
    aggregate.codeAssessment = { status: results.every(r => r.codeAssessment?.status === 'cache-hit') ? 'cache-hit' : results.some(r => r.codeAssessment?.status === 'not-evaluated') ? 'not-evaluated' : 'evaluated',
      fingerprint: sha256(canonicalJson(results.map(r => r.codeAssessment?.fingerprint ?? '').sort())),
      ...(first.codeAssessment?.dependencyFingerprint === undefined ? {} : { dependencyFingerprint: first.codeAssessment.dependencyFingerprint }) };
  }
  if (aggregate.allowed && first.environmentAssessment?.status === 'approved' && first.environmentAssessment.approvalId !== undefined && first.environmentAssessment.environmentFingerprint !== undefined && first.executionAssessment?.executionFingerprint !== undefined) {
    try {
      const db = openDatabase();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + EXECUTION_TICKET_TTL_SECONDS * 1000).toISOString();
      const codeFingerprint = sha256(canonicalJson(results.map((result) => result.codeAssessment?.fingerprint ?? '').sort()));
      const ticket = issueExecutionTicket(db, { approvalId: first.environmentAssessment.approvalId, projectId: projectId(root), environmentFingerprint: first.environmentAssessment.environmentFingerprint, codeFingerprint, executionFingerprint: first.executionAssessment.executionFingerprint }, now.toISOString(), expiresAt);
      const aggregateCodeAssessment = { status: results.every((result) => result.codeAssessment?.status === 'cache-hit') ? 'cache-hit' as const : 'evaluated' as const, fingerprint: codeFingerprint, ...(first.codeAssessment?.dependencyFingerprint === undefined ? {} : { dependencyFingerprint: first.codeAssessment.dependencyFingerprint }) };
      aggregate = { ...aggregate, codeAssessment: aggregateCodeAssessment, executionAssessment: { ...first.executionAssessment, ticket: ticket.token, ticketExpiresAt: ticket.expiresAt } };
    } catch {
      aggregate = { ...aggregate, allowed: false, needsHumanReview: true, decision: 'review', errorCode: 'EXECUTION_TICKET_ERROR', reason: 'An aggregate execution ticket could not be issued.' };
    }
  }
  return aggregate;
}
