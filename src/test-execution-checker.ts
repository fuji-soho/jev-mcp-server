import type { Config } from './config.js';
import { evaluationIdentity, isVersionedModel } from './config.js';
import { checkCommandWithJev, JevError } from './cloudflare-jev.js';
import { buildCommandStaticFindings } from './command-checker.js';
import { ExecutionRegistrationError } from './execution-conditions.js';
import { ExecutionEvidenceError, snapshotExecution } from './execution-profile.js';
import { customFindings, evaluateTestCode, redactTestText } from './test-checker.js';
import { canonicalJson, projectId, readRelatedCode, sha256 } from './safety-fingerprint.js';
import { findPolicyMatches, loadEffectivePolicies, loadEffectiveTestPolicies, strictestDecision } from './policy.js';
import { openDatabase } from './storage/sqlite.js';
import { executionApprovalFor } from './storage/test-execution-approval.js';
import { bindHumanReviewModel, createOrGetHumanReview, lookupApprovedHumanReview } from './storage/human-review.js';
import { insertAudit } from './storage/audit-log.js';
import type { StaticFinding, TestCheckInput, TestCheckResult, PolicyFinding } from './types.js';

function blocked(reason: string, errorCode: string, kind: NonNullable<TestCheckResult['reviewReasons']>[number]['kind'] = 'evidence-incomplete'): TestCheckResult {
  return { ok: false, dangerous: null, allowed: false, needsHumanReview: false, decision: 'review', reason, errorCode,
    categories: [], riskScore: null, staticFindings: [], policyVersion: 'unavailable', model: 'typesafe/jev',
    reviewReasons: [{ kind, approvable: false, message: reason }] };
}

export async function evaluateTestExecution(config: Config, input: TestCheckInput): Promise<TestCheckResult> {
  input = {...input, framework:input.framework ?? 'laravel', environment:input.environment ?? 'testing'};
  let commandStatic;
  try { commandStatic = buildCommandStaticFindings(input, true); }
  catch { return blocked('Safety policy could not be loaded. Correct the policy and recheck.', 'POLICY_ERROR', 'evaluation-error'); }
  const deny = (findings: StaticFinding[], policyFindings: PolicyFinding[]): TestCheckResult => ({
    ...blocked('Static safety rules deny this test execution.', 'STATIC_DENY'), ok: true, dangerous: 1, riskScore: 1,
    decision: 'deny', staticFindings: findings.map(f => f.message), policyFindings,
    findings: findings.map(f => ({ ...f, source: 'static' as const })), categories: [...new Set(findings.map(f => f.category))],
    policyVersion: commandStatic.policyVersion, reviewReasons: [],
  });
  if (commandStatic.findings.some(f => f.decision === 'deny')) return deny(commandStatic.findings, commandStatic.policyFindings);
  try {
    const snapshot = snapshotExecution(input);
    const tests = snapshot.files.map(file => {
      const read = readRelatedCode(snapshot.root, [file]);
      if (read.status !== 'complete') throw new ExecutionEvidenceError('EXECUTION_EVIDENCE_INCOMPLETE', read.reason, file);
      const source = read.files[0]!;
      return { ok: true as const, target: source.key, content: source.content, digest: source.digest, bytes: source.bytes };
    });
    const commandPolicies = loadEffectivePolicies(snapshot.projectRoot), testPolicies = loadEffectiveTestPolicies(snapshot.projectRoot, input.framework);
    // Selection has been parsed as bounded literal file/filter values. A regex '*' inside
    // a quoted PHPUnit filter is not a filesystem wildcard or a new execution option.
    const findings = commandStatic.findings.filter(f => f.ruleId !== 'scope.broad-option');
    const policyFindings = [...commandStatic.policyFindings];
    const allSource = [...snapshot.evidence, ...snapshot.related, ...tests.flatMap(t => t.ok ? [{ key: t.target, content: t.content }] : [])];
    for (const file of allSource) {
      for (const policy of [commandPolicies, testPolicies]) {
        const matches = findPolicyMatches(policy, file.content);
        findings.push(...matches.findings.map(f => ({ ...f, file: file.key })));
        policyFindings.push(...matches.policyFindings.map(f => ({ ...f, file: file.key })));
      }
      findings.push(...customFindings(input, file.content, true).map(f => ({ ...f, file: file.key })));
    }
    // Caller runtime claims cannot contradict the restrictive approved resource scope.
    if (input.runtime?.productionAccess || input.runtime?.persistentStorageAccess || input.persistentDatabaseAccess || input.runtime?.networkAccess || input.runtime?.credentialAccess
      || (input.runtimeDatabase && (input.runtimeDatabase.connection !== 'sqlite' || input.runtimeDatabase.database !== ':memory:'))) {
      findings.push({ ruleId: 'execution.resource-scope-conflict', category: 'environment-isolation', severity: 'critical', decision: 'deny', message: 'Runtime input contradicts the approved SQLite-memory/no-network/no-credentials scope.' });
    }
    if (findings.some(f => f.decision === 'deny')) return deny(findings, policyFindings);
    const db = openDatabase();
    let approval;
    try { approval = executionApprovalFor(db, snapshot, new Date().toISOString(), input.executionApprovalId); }
    catch (error) {
      if (error instanceof Error && error.message === 'EXECUTION_APPROVAL_MISMATCH') return blocked('The requested execution approval does not match the active project and execution conditions.', 'EXECUTION_APPROVAL_MISMATCH');
      throw error;
    }
    const approvalDetails = { status: approval.status as 'pending' | 'approved', approvalId: approval.approvalId, fingerprint: snapshot.fingerprint, scope: {...snapshot.scope, reviewTrigger:approval.scope.reviewTrigger} };
    const common = { ...(approval.conditionId ? { executionConditionsId:approval.conditionId } : {}), executionApproval: approvalDetails, executionAssessment: { runnerMatched: true, selectorsAllowed: true, executionFingerprint: snapshot.executionFingerprint, sourceVerification: snapshot.conditions?.target.mode && snapshot.conditions.target.mode !== 'local' ? 'human-approved-container' as const : 'local-runtime-inspected' as const, containerInternalsVerified:false },
      policyVersion: `${commandPolicies.version};${testPolicies.version}`, policyFindings, jevProvider: config.provider, requestedModel: config.requestedModel };
    const audit = (result: TestCheckResult, actualModel?: string): void => {
      insertAudit(db, { toolName: 'jev_check_test', targetType: 'test-execution', targetKey: snapshot.profilePath, projectId: projectId(snapshot.projectRoot),
        fingerprint: snapshot.executionFingerprint, policyHash: snapshot.policyHash, cacheStatus: 'disabled', finalDecision: result.decision,
        allowed: result.allowed, needsHumanReview: result.needsHumanReview, modelVersion: evaluationIdentity(config), actualModel,
        jevProvider: config.provider, requestedModel: config.requestedModel, evaluatorVersion: 'jev-test-execution-v1',
        reason: result.reason, summary: canonicalJson({ executionApprovalId: approval.approvalId, status: approval.status }) });
    };
    if (approval.status !== 'approved') {
      const reason = `${approval.scope.reviewTrigger === 'conditions-changed' ? 'Execution conditions or safety evidence changed. ' : approval.scope.reviewTrigger === 'approval-inactive' ? 'The previous approval is inactive. ' : 'Initial execution registration. '}Human confirmation is required for the current command, complete safe runner, guards and resource scope. Approval does not approve test code.`;
      const result: TestCheckResult = { ...blocked(reason, 'EXECUTION_APPROVAL_REQUIRED'), ...common, ok: true, needsHumanReview: true,
        executionReviewId: approval.approvalId, staticFindings: findings.map(f => f.message),
        reviewReasons: [{ kind: 'execution-approval', approvable: true, message: reason, reviewId: approval.approvalId }] };
      audit(result); return result;
    }
    const executionContext = JSON.stringify({ context: input.context === undefined ? undefined : redactTestText(input.context), scope: snapshot.scope,
      calls: snapshot.evidence.map(f => ({ file: f.key, content: redactTestText(f.content) })) });
    let response;
    try {
      if (Buffer.byteLength(executionContext) > 192 * 1024) throw new JevError('EXECUTION_EVIDENCE_INCOMPLETE', 'Execution request exceeds its size limit.');
      response = await checkCommandWithJev(config, { command: redactTestText(input.command), cwd: snapshot.root, environment: snapshot.profile.environment,
        context: redactTestText(executionContext) });
    } catch (error) {
      const result = { ...blocked('Current command evaluation failed. An execution approval or code cache cannot bypass it.', error instanceof JevError ? error.code : 'INTERNAL_ERROR', 'evaluation-error'), ...common };
      audit(result); return result;
    }
    const dangerous = response.answers.command_dangerous!.noul;
    if (dangerous >= 0.8) {
      const result: TestCheckResult = { ...deny(findings, policyFindings), ...common, actualModel: response.model, dangerous, riskScore: dangerous, reason: 'Jev denied the current execution command.' };
      audit(result, response.model); return result;
    }
    const related = [...new Map([...snapshot.evidence, ...snapshot.related].map(f => [f.key, f])).values()].sort((a, b) => a.key.localeCompare(b.key));
    const dependencyFingerprint = sha256(canonicalJson(related.map(({ key, digest, bytes }) => ({ key, digest, bytes }))));
    let codeResult = await evaluateTestCode(config, { ...input, cwd: snapshot.root, testFiles: snapshot.files }, {
      assessment: { version: 3, status: 'verified', fingerprintMatched: true, runtimeMatched: snapshot.conditions?.target.mode !== 'podman' && snapshot.conditions?.target.mode !== 'docker', profileDigest: snapshot.fingerprint,
        dependencyFingerprint, profileName: snapshot.profile.name, environmentFingerprint: snapshot.fingerprint },
      jevContext: { version: 3, executionConditions: snapshot.fingerprint, resources: snapshot.profile.resources, environmentApproved: true },
      executionApproved: true, policyRoot: snapshot.projectRoot, dbRegistered: snapshot.conditions !== undefined, relatedCode: { status: 'complete', fingerprint: dependencyFingerprint, files: related },
    }, tests);
    if (snapshot.conditions) { const {safetyProfile: _legacyProfile, ...normalResult} = codeResult; codeResult = normalResult; }
    if (!codeResult.ok || codeResult.decision === 'deny') {
      const { reviewId: _reviewId, reviewIds: _reviewIds, ...withoutIds } = codeResult;
      const result: TestCheckResult = { ...withoutIds, ...common, allowed: false, needsHumanReview: false,
        reviewReasons: codeResult.decision === 'deny' ? [] : [{ kind: 'evaluation-error', approvable: false, message: codeResult.reason }] };
      audit(result, response.model); return result;
    }
    const commandReviews = findings.filter(f => f.decision === 'review');
    let commandReviewId: string | undefined;
    const commandNeedsReview = dangerous >= 0.4 || commandReviews.length > 0;
    if (commandNeedsReview) {
      if (!isVersionedModel(response.model)) {
        const result = { ...blocked('The command evaluation must identify a versioned actual model before Human Review can be issued.', 'JEV_MODEL_ID_UNVERIFIED'), ...common };
        audit(result, response.model); return result;
      }
      const now = new Date();
      const codeIdentity = sha256(canonicalJson(tests.flatMap(t => t.ok ? [{ file: t.target, digest: t.digest }] : [])));
      const fingerprint = sha256(canonicalJson({ execution: snapshot.executionFingerprint, dependencies: snapshot.dependencyFingerprint,
        codeIdentity, model: evaluationIdentity(config), context: input.context === undefined ? null : sha256(input.context), diff: input.diff === undefined ? null : sha256(input.diff), reviews: commandReviews }));
      const key = bindHumanReviewModel({ projectId: projectId(snapshot.projectRoot), targetType: 'test-execution', targetKey: snapshot.profilePath, fingerprint,
        commandHash: sha256(input.command), testFilesHash: codeIdentity, cwdHash: sha256(snapshot.projectRoot), policyHash: snapshot.policyHash,
        contextHash: fingerprint, runtimeHash: snapshot.fingerprint }, response.model);
      if (!lookupApprovedHumanReview(db, key, now.toISOString())) commandReviewId = createOrGetHumanReview(db, key, now.toISOString(), new Date(now.getTime() + 3_600_000).toISOString()).reviewId;
    }
    const decision = strictestDecision([codeResult.decision, commandReviewId ? 'review' : 'allow']);
    const reasons: NonNullable<TestCheckResult['reviewReasons']> = [];
    if (commandReviewId) reasons.push({ kind: 'command-risk', approvable: true, message: 'Separate Human Review is required for current command or policy risks.', reviewId: commandReviewId });
    for (const id of codeResult.reviewIds ?? (codeResult.reviewId ? [codeResult.reviewId] : [])) reasons.push({ kind: 'code-risk', approvable: true, message: codeResult.reason, reviewId: id });
    if (codeResult.decision === 'review' && !codeResult.reviewId && !codeResult.reviewIds?.length) reasons.push({ kind: 'evaluation-error', approvable: false, message: codeResult.reason });
    const reviewIds = [...new Set([...(codeResult.reviewIds ?? (codeResult.reviewId ? [codeResult.reviewId] : [])), ...(commandReviewId ? [commandReviewId] : [])])];
    const result: TestCheckResult = { ...codeResult, ...common, decision, allowed: decision === 'allow' && codeResult.allowed,
      needsHumanReview: decision === 'review' && reasons.some(r => r.approvable), reviewReasons: decision === 'deny' ? [] : reasons,
      ...(reviewIds.length ? { reviewIds, ...(reviewIds.length === 1 ? { reviewId: reviewIds[0] } : {}) } : {}),
      dangerous: Math.max(dangerous, codeResult.dangerous ?? 0), riskScore: Math.max(dangerous, codeResult.riskScore ?? 0),
      staticFindings: [...new Set([...codeResult.staticFindings, ...findings.map(f => f.message)])],
      reason: commandReviewId && decision !== 'deny' ? 'Command review remains unresolved; execution approval alone is insufficient.' : codeResult.reason };
    audit(result, response.model); return result;
  } catch (error) {
    if (error instanceof ExecutionRegistrationError) {
      const kind = error.code.includes('AMBIGUOUS') ? 'conditions-ambiguous' : error.code.includes('MISMATCH') ? 'conditions-mismatch' : error.code === 'UNSUPPORTED_EXECUTION_FORM' ? 'unsupported-form' : 'registration-incomplete';
      return {...blocked(error.message,error.code,kind), ...(error.missingFields.length ? {missingFields:error.missingFields} : {}), ...(error.candidates.length ? {conditionCandidates:error.candidates} : {})};
    }
    if (error instanceof ExecutionEvidenceError) {
      const findings = [...commandStatic.findings], policyFindings = [...commandStatic.policyFindings];
      try {
        for (const file of error.evidence) {
          for (const policies of [loadEffectivePolicies(input.cwd), loadEffectiveTestPolicies(input.cwd, input.framework)]) {
            const matches = findPolicyMatches(policies, file.content);
            findings.push(...matches.findings.map(f => ({ ...f, file: file.key })));
            policyFindings.push(...matches.policyFindings.map(f => ({ ...f, file: file.key })));
          }
          findings.push(...customFindings(input, file.content, true));
        }
      } catch { /* An incomplete policy never grants permission. */ }
      if (findings.some(f => f.decision === 'deny')) return deny(findings, policyFindings);
      return {...blocked(`${error.message}${error.file ? ` File: ${error.file}` : ''}`, error.code, error.code === 'UNSUPPORTED_EXECUTION_FORM' ? 'unsupported-form' : 'evidence-incomplete'), ...(error.file ? {evidenceErrors:[{file:error.file,code:error.code,message:error.message}]} : {})};
    }
    return blocked('Execution evidence, policy or approval storage is unavailable. Correct the configuration and recheck.', 'EXECUTION_CHECK_ERROR', 'evaluation-error');
  }
}
