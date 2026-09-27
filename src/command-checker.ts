import type { Config } from './config.js';
import { checkCommandWithJev, JevError } from './cloudflare-jev.js';
import { findPolicyMatches, loadEffectivePolicies, strictestDecision } from './policy.js';
import type { CommandCheckInput, CommandCheckResult, PolicyFinding, RiskCategory, StaticFinding } from './types.js';

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

function buildStaticFindings(input: CommandCheckInput): { findings: StaticFinding[]; policyFindings: PolicyFinding[]; policyVersion: string } {
  const policies = loadEffectivePolicies(input.cwd);
  const text = [input.command, input.cwd, input.environment, input.target, input.context]
    .filter((item): item is string => item !== undefined).join('\n');
  const policyMatches = findPolicyMatches(policies, text);
  const findings = policyMatches.findings;
  if (input.environment === 'production' && /\b(?:delete|destroy|drop|truncate|reset|clean|stop|disable|restart|reload|deploy|apply)\b/iu.test(input.command)) {
    findings.push({ ruleId: 'context.production-change', category: 'production-impact', severity: 'high', decision: 'review', message: 'A state-changing command targets a production environment.' });
  }
  if (/(?:^|\s)(?:\/|\/etc|\/var|\/home|~)(?:\s|$)/u.test(input.cwd ?? input.target ?? '')) {
    findings.push({ ruleId: 'context.privileged-path', category: 'scope', severity: 'high', decision: 'review', message: 'The command context points at a broad or privileged filesystem path.' });
  }
  if (/(?:--recursive|\s-R\b|\s-r\b|--force|\s-f\b|--delete|\*|\ball\b)/iu.test(input.command)) {
    findings.push({ ruleId: 'scope.broad-option', category: 'scope', severity: 'medium', decision: 'review', message: 'The command includes an option or wildcard that may broaden its impact.' });
  }
  return { findings: [...new Map(findings.map((finding) => [finding.ruleId, finding])).values()], policyFindings: policyMatches.policyFindings, policyVersion: policies.version };
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
  const validationError = validateInput(input);
  let staticResult: { findings: StaticFinding[]; policyFindings: PolicyFinding[]; policyVersion: string };
  try { staticResult = buildStaticFindings(input); } catch { return reviewResult('The safety policy could not be loaded. Human review is required.', 'POLICY_ERROR'); }
  if (validationError !== undefined) return reviewResult(validationError, 'INVALID_INPUT', staticResult.findings, staticResult.policyFindings, staticResult.policyVersion);

  try {
    const response = await checkCommandWithJev(config, commandState(input));
    const dangerous = response.answers?.command_dangerous?.noul;
    if (dangerous === undefined) return reviewResult('Jev did not return a dangerousness score.', 'JEV_INVALID_RESPONSE', staticResult.findings, staticResult.policyFindings, staticResult.policyVersion);
    const risks = mergeScore(scoreFromFindings(staticResult.findings), dangerous);
    const categories = [...new Set([...staticResult.findings.map((finding) => finding.category), ...(dangerous >= 0.4 ? ['irreversibility' as const] : [])])];
    const riskScore = aggregateScore(risks, dangerous);
    const deny = staticResult.findings.find((finding) => finding.decision === 'deny');
    const review = staticResult.findings.find((finding) => finding.decision === 'review');
    const jevDecision = dangerous >= 0.8 ? 'deny' : dangerous >= 0.4 ? 'review' : 'allow';
    const decision = strictestDecision([jevDecision, deny === undefined ? 'allow' : 'deny', review === undefined ? 'allow' : 'review']);
    const matchedPolicy = staticResult.policyFindings.find((finding) => finding.decision === decision);
    const common = { ok: true, dangerous, categories, riskScore, risks, staticFindings: staticResult.findings, policyFindings: staticResult.policyFindings, policyVersion: staticResult.policyVersion, model: 'combined' as const };
    if (decision === 'deny') return { ...common, allowed: false, needsHumanReview: false, decision, reason: matchedPolicy?.reason ?? 'The command has a high probability of causing destructive or irreversible changes.' };
    if (decision === 'review') return { ...common, allowed: false, needsHumanReview: true, decision, reason: matchedPolicy?.reason ?? 'The command has a moderate probability of being destructive and requires human review.' };
    return { ...common, allowed: true, needsHumanReview: false, decision, reason: 'No clear destructive risk was found in the command, context, or configured safety policies.' };
  } catch (error) {
    if (error instanceof JevError) return reviewResult('Jev could not complete the safety check. Human review is required before execution.', error.code, staticResult.findings, staticResult.policyFindings, staticResult.policyVersion);
    return reviewResult('An unexpected error occurred during the safety check.', 'INTERNAL_ERROR', staticResult.findings, staticResult.policyFindings, staticResult.policyVersion);
  }
}
