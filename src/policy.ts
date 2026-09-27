import { lstatSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Decision, PolicyFinding, PolicySource, RiskCategory, StaticFinding } from './types.js';

const MAX_POLICY_FILE_BYTES = 256 * 1024;
const MAX_RULES = 200;
const MAX_MATCH_LENGTH = 2_000;
const MAX_REASON_LENGTH = 2_000;
const DECISION_RANK: Record<Decision, number> = { allow: 0, review: 1, deny: 2 };
type Severity = StaticFinding['severity'];

interface ExternalPolicyRule {
  name: string;
  pattern?: string;
  match?: { type: 'exact' | 'contains'; value: string };
  category?: string | undefined;
  severity?: Severity | undefined;
  decision: Decision;
  reason: string;
}
interface Matcher { test(text: string): boolean; }
export interface LoadedPolicyRule {
  name: string; category: RiskCategory; severity: Severity; decision: Decision; reason: string;
  source: PolicySource; matcher: Matcher;
}
export interface LoadedPolicy { version: string; rules: LoadedPolicyRule[]; }
export interface EffectivePolicies { policies: LoadedPolicy[]; version: string; hash: string; }

export class PolicyLoadError extends Error {
  readonly code = 'POLICY_ERROR';
  constructor(message: string) { super(message); this.name = 'PolicyLoadError'; }
}

function policyRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'policies'); }
function policyPath(): string { return join(policyRoot(), 'default.json'); }
function testPolicyPath(name: string): string { return join(policyRoot(), 'tests', `${name}.json`); }
function fileHash(path: string): string {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return `missing:${path}`; }
}
function policyHash(paths: string[]): string { return createHash('sha256').update(paths.map((path) => `${path}\0${fileHash(path)}\0`).sort().join('')).digest('hex'); }
function isDecision(value: unknown): value is Decision { return value === 'allow' || value === 'review' || value === 'deny'; }
function isSeverity(value: unknown): value is Severity { return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'; }
function isRiskCategory(value: unknown): value is RiskCategory {
  return typeof value === 'string' && ['persistent-data', 'data-loss', 'filesystem', 'database', 'external-service', 'network', 'environment-isolation', 'configuration', 'destructive-operation', 'git', 'availability', 'production-impact', 'security', 'credential', 'irreversibility', 'scope', 'deployment', 'dependencies'].includes(value);
}
function validateLimit(name: string, value: string, label: string): void {
  const max = label === 'reason' ? MAX_REASON_LENGTH : MAX_MATCH_LENGTH;
  if (value.length === 0 || value.length > max) throw new PolicyLoadError(`Policy rule ${name} has an invalid ${label}.`);
}

function readJsonFile(path: string, required: boolean): unknown | undefined {
  let metadata;
  try { metadata = lstatSync(path); } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new PolicyLoadError(`Unable to read policy file: ${path}`);
  }
  if (metadata.isSymbolicLink()) throw new PolicyLoadError('Policy files must not be symbolic links.');
  if (!metadata.isFile() || metadata.size > MAX_POLICY_FILE_BYTES) throw new PolicyLoadError('Policy file is not a regular file or is too large.');
  try { return JSON.parse(readFileSync(path, 'utf8')) as unknown; } catch { throw new PolicyLoadError('Policy file contains invalid JSON.'); }
}

function externalRule(value: unknown): ExternalPolicyRule {
  if (typeof value !== 'object' || value === null) throw new PolicyLoadError('Policy contains an invalid rule.');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.name !== 'string' || candidate.name.trim() === '') throw new PolicyLoadError('Policy rule name must be a non-empty string.');
  if (!isDecision(candidate.decision) || typeof candidate.reason !== 'string') throw new PolicyLoadError(`Policy rule ${candidate.name} has an invalid decision or reason.`);
  validateLimit(candidate.name, candidate.reason, 'reason');
  if (candidate.category !== undefined && !isRiskCategory(candidate.category)) throw new PolicyLoadError(`Policy rule ${candidate.name} has an unsupported category.`);
  if (candidate.severity !== undefined && !isSeverity(candidate.severity)) throw new PolicyLoadError(`Policy rule ${candidate.name} has an invalid severity.`);
  if (typeof candidate.pattern === 'string') {
    validateLimit(candidate.name, candidate.pattern, 'pattern');
    if (candidate.match !== undefined) throw new PolicyLoadError(`Policy rule ${candidate.name} cannot use pattern and match together.`);
    return { name: candidate.name, pattern: candidate.pattern, category: candidate.category as string | undefined, severity: candidate.severity as Severity | undefined, decision: candidate.decision, reason: candidate.reason };
  }
  const match = candidate.match;
  if (typeof match !== 'object' || match === null) throw new PolicyLoadError(`Policy rule ${candidate.name} needs pattern or match.`);
  const item = match as Record<string, unknown>;
  if ((item.type !== 'exact' && item.type !== 'contains') || typeof item.value !== 'string') throw new PolicyLoadError(`Policy rule ${candidate.name} has an invalid match.`);
  validateLimit(candidate.name, item.value, 'match');
  return { name: candidate.name, match: { type: item.type, value: item.value }, category: candidate.category as string | undefined, severity: candidate.severity as Severity | undefined, decision: candidate.decision, reason: candidate.reason };
}
function defaultSeverity(decision: Decision): Severity { return decision === 'deny' ? 'critical' : decision === 'review' ? 'medium' : 'low'; }

function externalPolicy(value: unknown, source: Exclude<PolicySource, 'builtin'>): LoadedPolicy {
  if (typeof value !== 'object' || value === null) throw new PolicyLoadError('Policy has an invalid shape.');
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !Array.isArray(candidate.rules) || candidate.rules.length > MAX_RULES) throw new PolicyLoadError('Policy version or rules are invalid.');
  const rules = candidate.rules.map(externalRule).map((rule) => {
    const matcher: Matcher = rule.match?.type === 'exact'
      ? { test: (text) => text === rule.match?.value }
      : rule.match?.type === 'contains'
        ? { test: (text) => text.includes(rule.match?.value ?? '') }
        : { test: (text) => text.includes(rule.pattern ?? '') };
    return { name: rule.name, category: (rule.category ?? 'scope') as RiskCategory, severity: rule.severity ?? defaultSeverity(rule.decision), decision: rule.decision, reason: rule.reason, source, matcher };
  });
  return { version: `${source}:1`, rules };
}

function loadBuiltinPolicyAt(path: string, versionPrefix: string): LoadedPolicy {
  const parsed = readJsonFile(path, true);
  if (typeof parsed !== 'object' || parsed === null) throw new PolicyLoadError('The default safety policy has an invalid shape.');
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate.version !== 'string' || !Array.isArray(candidate.rules) || candidate.rules.length > MAX_RULES) throw new PolicyLoadError('The default safety policy has an invalid shape.');
  const rules = candidate.rules.map((value) => {
    if (typeof value !== 'object' || value === null) throw new PolicyLoadError('The default safety policy contains an invalid rule.');
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.pattern !== 'string' || !isRiskCategory(item.category) || !isSeverity(item.severity) || !isDecision(item.decision) || typeof item.message !== 'string') throw new PolicyLoadError('The default safety policy contains an invalid rule.');
    try {
      const regex = new RegExp(item.pattern, typeof item.flags === 'string' ? item.flags : 'iu');
      return { name: item.id, category: item.category, severity: item.severity, decision: item.decision, reason: item.message, source: 'builtin' as const, matcher: { test: (text: string) => { regex.lastIndex = 0; return regex.test(text); } } };
    } catch { throw new PolicyLoadError('The default safety policy contains an invalid regular expression.'); }
  });
  return { version: `${versionPrefix}:${candidate.version}`, rules };
}

export function loadDefaultPolicy(): LoadedPolicy {
  return loadBuiltinPolicyAt(policyPath(), 'builtin');
}

export function loadTestPolicies(framework?: string): LoadedPolicy[] {
  const policies = [loadBuiltinPolicyAt(testPolicyPath('generic'), 'builtin:test:generic')];
  const normalized = framework?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (normalized !== undefined && normalized !== '' && normalized !== 'generic') {
    const path = testPolicyPath(normalized);
    try {
      policies.push(loadBuiltinPolicyAt(path, `builtin:test:${normalized}`));
    } catch (error) {
      if (!(error instanceof PolicyLoadError) || !String(error.message).includes(path)) throw error;
    }
  }
  return policies;
}

function configDirectory(environment: NodeJS.ProcessEnv, homeDirectory: string): string {
  if (process.platform === 'win32') return resolve(environment.APPDATA?.trim() || join(homeDirectory, 'AppData', 'Roaming'), 'jev-mcp');
  return resolve(environment.XDG_CONFIG_HOME?.trim() || join(homeDirectory, '.config'), 'jev-mcp');
}
export function resolveUserPolicyPath(environment: NodeJS.ProcessEnv = process.env, homeDirectory = homedir()): string { return join(configDirectory(environment, homeDirectory), 'policy.json'); }
export function resolveProjectPolicyPath(cwd: string): string { return join(resolve(cwd), '.jev-policy.json'); }

export function loadEffectivePolicies(cwd: string | undefined, environment: NodeJS.ProcessEnv = process.env): EffectivePolicies {
  const policies: LoadedPolicy[] = [loadDefaultPolicy()];
  const user = readJsonFile(resolveUserPolicyPath(environment), false);
  if (user !== undefined) policies.push(externalPolicy(user, 'user'));
  if (cwd !== undefined) {
    try {
      if (!statSync(resolve(cwd)).isDirectory()) throw new PolicyLoadError('Project cwd is not a directory.');
      const project = readJsonFile(resolveProjectPolicyPath(cwd), false);
      if (project !== undefined) policies.push(externalPolicy(project, 'project'));
    } catch (error) {
      if (error instanceof PolicyLoadError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PolicyLoadError('Project cwd could not be inspected.');
      // A caller may provide a future/nonexistent working directory. There is no policy to load yet.
    }
  }
  const paths = [policyPath(), resolveUserPolicyPath(environment)];
  if (cwd !== undefined) paths.push(resolveProjectPolicyPath(cwd));
  return { policies, version: policies.map((policy) => policy.version).join(';'), hash: policyHash(paths) };
}

export function loadEffectiveTestPolicies(
  cwd: string | undefined,
  framework: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
): EffectivePolicies {
  const policies: LoadedPolicy[] = [...loadTestPolicies(framework)];
  const user = readJsonFile(resolveUserPolicyPath(environment), false);
  if (user !== undefined) policies.push(externalPolicy(user, 'user'));
  if (cwd !== undefined) {
    try {
      if (!statSync(resolve(cwd)).isDirectory()) throw new PolicyLoadError('Project cwd is not a directory.');
      const project = readJsonFile(resolveProjectPolicyPath(cwd), false);
      if (project !== undefined) policies.push(externalPolicy(project, 'project'));
    } catch (error) {
      if (error instanceof PolicyLoadError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new PolicyLoadError('Project cwd could not be inspected.');
    }
  }
  const normalized = framework?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const paths = [policyPath(), testPolicyPath('generic'), resolveUserPolicyPath(environment)];
  if (normalized !== undefined && normalized !== '' && normalized !== 'generic') paths.push(testPolicyPath(normalized));
  if (cwd !== undefined) paths.push(resolveProjectPolicyPath(cwd));
  return { policies, version: policies.map((policy) => policy.version).join(';'), hash: policyHash(paths) };
}

export function findPolicyMatches(policies: EffectivePolicies, text: string): { findings: StaticFinding[]; policyFindings: PolicyFinding[] } {
  const policyFindings: PolicyFinding[] = [];
  const candidates = text.split('\n');
  for (const policy of policies.policies) for (const rule of policy.rules) if (candidates.some((candidate) => rule.matcher.test(candidate))) {
    policyFindings.push({ source: rule.source, rule: rule.name, category: rule.category, severity: rule.severity, decision: rule.decision, reason: rule.reason });
  }
  return { policyFindings, findings: policyFindings.map((finding) => ({ ruleId: finding.source === 'builtin' ? finding.rule : `${finding.source}:${finding.rule}`, category: finding.category, severity: finding.severity, decision: finding.decision, message: finding.reason })) };
}
export function strictestDecision(values: Decision[]): Decision { return values.reduce<Decision>((current, value) => DECISION_RANK[value] > DECISION_RANK[current] ? value : current, 'allow'); }
