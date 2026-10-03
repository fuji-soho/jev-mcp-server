import { evaluationIdentity, isVersionedModel, type Config } from './config.js';
import { checkCommandWithJev, JevError } from './cloudflare-jev.js';
import { findPolicyMatches, loadEffectivePolicies, strictestDecision } from './policy.js';
import type { CommandCheckInput, CommandCheckResult, PolicyFinding, RiskCategory, StaticFinding } from './types.js';
import { openDatabase } from './storage/sqlite.js';
import { insertAudit } from './storage/audit-log.js';
import { commandScopeFindings, COMMAND_SCOPE_REVIEW_MESSAGE } from './command-scope.js';
import { buildFingerprint, canonicalJson, EVALUATOR_VERSION, projectId, sha256 } from './safety-fingerprint.js';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { logEvent } from './logger.js';
import { bindHumanReviewModel, createOrGetHumanReview, lookupApprovedHumanReview, markHumanReviewUsed, type HumanReviewKey } from './storage/human-review.js';

export const COMMAND_EVALUATOR_VERSION = `${EVALUATOR_VERSION}:command-scope-v1:no-command-cache-v1:command-human-review-v1`;

const MAX_COMMAND_LENGTH = 16_000;
const MAX_CONTEXT_LENGTH = 16_000;
const MAX_FIELD_LENGTH = 4_000;

function reviewResult(reason: string, errorCode?: string, staticFindings: StaticFinding[] = [], policyFindings: PolicyFinding[] = [], policyVersion = 'unavailable'): CommandCheckResult {
  return { ok: false, dangerous: null, allowed: false, needsHumanReview: true, decision: 'review', reason,
    categories: [...new Set(staticFindings.map((finding) => finding.category))], riskScore: null, staticFindings,
    ...(policyFindings.length === 0 ? {} : { policyFindings }), policyVersion, model: 'combined', ...(errorCode === undefined ? {} : { errorCode }) };
}

function validateInput(input: CommandCheckInput): string | undefined {
  if (input.command.trim() === '') return 'command must not be empty.';
  if (input.command.length > MAX_COMMAND_LENGTH) return `command exceeds the ${MAX_COMMAND_LENGTH}-character limit.`;
  if (input.context !== undefined && input.context.length > MAX_CONTEXT_LENGTH) return `context exceeds the ${MAX_CONTEXT_LENGTH}-character limit.`;
  for (const [name, value] of [['cwd', input.cwd], ['target', input.target]] as const) {
    if (value !== undefined && value.length > MAX_FIELD_LENGTH) return `${name} exceeds the ${MAX_FIELD_LENGTH}-character limit.`;
  }
  return undefined;
}

function redactSecrets(value: string): string {
  return value.replace(/((?:token|password|secret|private[_-]?key|access[_-]?key|api[_-]?key|credential)s?\s*[=:]\s*)([^\s,;&]+)/giu, '$1[REDACTED]')
    .replace(/(--?(?:token|password|secret|api[-_]?key|access[-_]?key|private[-_]?key)(?:=|\s+))([^\s,;&]+)/giu, '$1[REDACTED]');
}

function commandState(input: CommandCheckInput): CommandCheckInput {
  return { command: redactSecrets(input.command), ...(input.cwd === undefined ? {} : { cwd: redactSecrets(input.cwd) }),
    ...(input.environment === undefined ? {} : { environment: input.environment }),
    ...(input.target === undefined ? {} : { target: redactSecrets(input.target) }),
    ...(input.context === undefined ? {} : { context: redactSecrets(input.context) }) };
}

export function buildCommandStaticFindings(input: CommandCheckInput, executionReviewed = false): { findings: StaticFinding[]; policyFindings: PolicyFinding[]; policyVersion: string; policyHash: string } {
  const policies = loadEffectivePolicies(input.cwd);
  const text = [input.command, input.cwd, input.environment, input.target, input.context]
    .filter((item): item is string => item !== undefined).join('\n');
  const policyMatches = findPolicyMatches(policies, text);
  const findings = [...policyMatches.findings, ...(executionReviewed ? [] : commandScopeFindings(input.command))];
  if (input.environment === 'production' && /\b(?:delete|destroy|drop|truncate|reset|clean|stop|disable|restart|reload|deploy|apply)\b/iu.test(input.command)) {
    findings.push({ ruleId: 'context.production-change', category: 'production-impact', severity: 'high', decision: 'review', message: 'A state-changing command targets a production environment.' });
  }
  if (/(?:^|\s)(?:\/|\/etc|\/var|\/home|~)(?:\s|$)/u.test(input.cwd ?? input.target ?? '')) {
    findings.push({ ruleId: 'context.privileged-path', category: 'scope', severity: 'high', decision: 'review', message: 'The command context points at a broad or privileged filesystem path.' });
  }
  if (/(?:--recursive|\s-R\b|\s-r\b|--force|\s-f\b|--delete|\*|\ball\b)/iu.test(input.command)) {
    findings.push({ ruleId: 'scope.broad-option', category: 'scope', severity: 'medium', decision: 'review', message: 'The command includes an option or wildcard that may broaden its impact.' });
  }
  return { findings: [...new Map(findings.map((finding) => [finding.ruleId, finding])).values()], policyFindings: policyMatches.policyFindings, policyVersion: policies.version, policyHash: policies.hash };
}

function scoreFromFindings(findings: StaticFinding[]): Partial<Record<RiskCategory, number>> {
  const score: Partial<Record<RiskCategory, number>> = {};
  const severityScore = { low: 0.25, medium: 0.5, high: 0.8, critical: 1 };
  for (const finding of findings) score[finding.category] = Math.max(score[finding.category] ?? 0, severityScore[finding.severity]);
  return score;
}

function mergeScore(staticRisks: Partial<Record<RiskCategory, number>>, dangerous: number): Partial<Record<RiskCategory, number>> {
  const risks = { ...staticRisks };
  if (dangerous > 0) risks.irreversibility = Math.max(risks.irreversibility ?? 0, dangerous);
  if (dangerous >= 0.4) risks['data-loss'] = Math.max(risks['data-loss'] ?? 0, dangerous);
  return risks;
}

function aggregateScore(risks: Partial<Record<RiskCategory, number>>, dangerous: number): number {
  return Number(Math.max(dangerous, ...Object.values(risks).filter((value): value is number => value !== undefined), 0).toFixed(3));
}

export async function evaluateCommand(config: Config, input: CommandCheckInput): Promise<CommandCheckResult> {
  const evaluation = { jevProvider: config.provider, requestedModel: config.requestedModel } as const;
  const modelVersion = evaluationIdentity(config);
  const validationError = validateInput(input);
  let staticResult: { findings: StaticFinding[]; policyFindings: PolicyFinding[]; policyVersion: string; policyHash: string };
  try { staticResult = buildCommandStaticFindings(input); } catch { return reviewResult('The safety policy could not be loaded. Human review is required.', 'POLICY_ERROR'); }
  const state = commandState(input);
  const root = (() => { try { return realpathSync(resolve(input.cwd ?? process.cwd())); } catch { return resolve(input.cwd ?? process.cwd()); } })();
  const pid = projectId(root);
  const contextHash = sha256(canonicalJson(state));
  const targetKey = input.target?.trim() || 'command';
  const auditIdentity = { projectId: pid, targetType: 'command', targetKey, fingerprint: buildFingerprint({ projectId: pid, targetType: 'command', targetKey, testSpecific: state, sharedContext: { environment: input.environment }, policyHash: staticResult.policyHash, contextHash, runtimeHash: contextHash, modelVersion, evaluatorVersion: COMMAND_EVALUATOR_VERSION }), policyHash: staticResult.policyHash, contextHash, runtimeHash: contextHash, modelVersion, evaluatorVersion: COMMAND_EVALUATOR_VERSION };
  const exactInputHash = sha256(canonicalJson(input));
  const humanReviewContext: Omit<HumanReviewKey, 'actualModel'> = {
    projectId: pid, targetType: 'command', targetKey, fingerprint: auditIdentity.fingerprint,
    commandHash: sha256(input.command), testFilesHash: sha256(canonicalJson([])), cwdHash: sha256(root),
    policyHash: staticResult.policyHash, contextHash: exactInputHash, runtimeHash: exactInputHash,
  };
  let db;
  try { db = openDatabase(); } catch { db = undefined; }
  const staticDecision = strictestDecision(staticResult.findings.map((finding) => finding.decision).concat(staticResult.policyFindings.map((finding) => finding.decision)));
  const audit = (result: CommandCheckResult, jevDecision?: 'allow'|'review'|'deny'): void => {
    if (!db) return;
    try { db.exec('BEGIN'); insertAudit(db, { requestId: requestId, projectId: pid, toolName: 'jev_check_command', targetType: 'command', targetKey, fingerprint: auditIdentity.fingerprint, cacheStatus: 'disabled', staticDecision, jevDecision, finalDecision: result.decision, allowed: result.allowed, needsHumanReview: result.needsHumanReview, policyHash: auditIdentity.policyHash, contextHash: auditIdentity.contextHash, runtimeHash: auditIdentity.runtimeHash, modelVersion, jevProvider: config.provider, requestedModel: config.requestedModel, actualModel: result.actualModel, evaluatorVersion: COMMAND_EVALUATOR_VERSION, reason: result.reason }); db.exec('COMMIT'); } catch { try { db.exec('ROLLBACK'); } catch { /* best effort */ } logEvent('audit_persistence_error', { tool: 'jev_check_command' }); }
  };
  const requestId = randomUUID();
  if (validationError !== undefined) { const result = reviewResult(validationError, 'INVALID_INPUT', staticResult.findings, staticResult.policyFindings, staticResult.policyVersion); audit(result); return result; }
  if (staticDecision === 'deny') {
    const matchedPolicy = staticResult.policyFindings.find((finding) => finding.decision === 'deny');
    const risks = scoreFromFindings(staticResult.findings);
    const result: CommandCheckResult = { ...evaluation, ok: true, dangerous: 1, allowed: false, needsHumanReview: false, decision: 'deny', reason: matchedPolicy?.reason ?? 'Static policy denied the command before Jev evaluation.', categories: [...new Set(staticResult.findings.map((finding) => finding.category))], riskScore: 1, risks, staticFindings: staticResult.findings, policyFindings: staticResult.policyFindings, policyVersion: staticResult.policyVersion, model: 'combined' };
    audit(result);
    return result;
  }

  try {
    const response = await checkCommandWithJev(config, state);
    const dangerous = response.answers?.command_dangerous?.noul;
    if (dangerous === undefined) { const result = { ...reviewResult('Jev did not return a dangerousness score.', 'JEV_INVALID_RESPONSE', staticResult.findings, staticResult.policyFindings, staticResult.policyVersion), ...evaluation }; audit(result); return result; }
    const risks = mergeScore(scoreFromFindings(staticResult.findings), dangerous);
    const categories = [...new Set([...staticResult.findings.map((finding) => finding.category), ...(dangerous >= 0.4 ? ['irreversibility' as const] : [])])];
    const riskScore = aggregateScore(risks, dangerous);
    const deny = staticResult.findings.find((finding) => finding.decision === 'deny');
    const review = staticResult.findings.find((finding) => finding.decision === 'review');
    const jevDecision = dangerous >= 0.8 ? 'deny' : dangerous >= 0.4 ? 'review' : 'allow';
    const decision = strictestDecision([jevDecision, deny === undefined ? 'allow' : 'deny', review === undefined ? 'allow' : 'review']);
    const matchedPolicy = staticResult.policyFindings.find((finding) => finding.decision === decision);
    const common = { ...evaluation, actualModel: response.model, ok: true, dangerous, categories, riskScore, risks, staticFindings: staticResult.findings, policyFindings: staticResult.policyFindings, policyVersion: staticResult.policyVersion, model: 'combined' as const };
    if (decision === 'deny') {
      const result = { ...common, allowed: false, needsHumanReview: false, decision, reason: matchedPolicy?.reason ?? 'The command has a high probability of causing destructive or irreversible changes.' };
      audit(result, jevDecision); return result;
    }
    if (decision === 'review') {
      const executionContentUnreviewed = staticResult.findings.some((finding) => finding.ruleId === 'command.execution-content-unreviewed');
      const reason = matchedPolicy?.reason ?? (executionContentUnreviewed ? COMMAND_SCOPE_REVIEW_MESSAGE : 'The command has a moderate probability of being destructive and requires human review.');
      const pending = { ...common, allowed: false, needsHumanReview: true, decision, reason };
      if (executionContentUnreviewed) { audit(pending, jevDecision); return pending; }
      if (!isVersionedModel(response.model)) {
        const result = { ...pending, errorCode: 'JEV_MODEL_ID_UNVERIFIED', reason: 'The API did not identify a versioned actual model. Human Approval cannot be safely matched; use a provider that reports a jev-X.Y.Z model ID.' };
        audit(result, jevDecision); return result;
      }
      const key = bindHumanReviewModel(humanReviewContext, response.model);
      if (db) {
        const now = new Date();
        const approved = lookupApprovedHumanReview(db, key, now.toISOString());
        if (approved) {
          const result = { ...common, allowed: true, needsHumanReview: false, decision: 'allow' as const, reason: 'A valid Human Approval matches the exact command, project, policy, context, and actual model.' };
          markHumanReviewUsed(db, approved.reviewId, now.toISOString());
          audit(result, jevDecision); return result;
        }
        try {
          const review = createOrGetHumanReview(db, key, now.toISOString(), new Date(now.getTime() + 60 * 60 * 1000).toISOString());
          const result = { ...pending, reviewId: review.reviewId };
          audit(result, jevDecision); return result;
        } catch { /* fail closed without an approvable ID */ }
      }
      const result = { ...pending, errorCode: 'HUMAN_REVIEW_STORE_ERROR', reason: 'The Human Review could not be stored. Recheck after the review store is available.' };
      audit(result, jevDecision); return result;
    }
    const result = { ...common, allowed: true, needsHumanReview: false, decision, reason: 'No clear destructive risk was found in the command, context, or configured safety policies.' };
    audit(result, jevDecision); return result;
  } catch (error) {
    if (error instanceof JevError) { const result = { ...reviewResult('Jev could not complete the safety check. Human review is required before execution.', error.code, staticResult.findings, staticResult.policyFindings, staticResult.policyVersion), ...evaluation }; audit(result); return result; }
    const result = { ...reviewResult('An unexpected error occurred during the safety check.', 'INTERNAL_ERROR', staticResult.findings, staticResult.policyFindings, staticResult.policyVersion), ...evaluation }; audit(result); return result;
  }
}
