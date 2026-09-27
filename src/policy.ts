import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Decision, RiskCategory, StaticFinding } from './types.js';

interface PolicyRule {
  id: string;
  pattern: string;
  category: RiskCategory;
  severity: StaticFinding['severity'];
  decision: Decision;
  message: string;
  flags?: string;
}

interface PolicyFile {
  version: string;
  rules: PolicyRule[];
}

export interface LoadedPolicy {
  version: string;
  rules: Array<PolicyRule & { matcher: RegExp }>;
}

function policyPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'policies', 'default.json');
}

export function loadDefaultPolicy(): LoadedPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(policyPath(), 'utf8')) as unknown;
  } catch {
    throw new Error('Unable to load the default safety policy.');
  }

  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || !('rules' in parsed)) {
    throw new Error('The default safety policy has an invalid shape.');
  }
  const candidate = parsed as Partial<PolicyFile>;
  if (typeof candidate.version !== 'string' || !Array.isArray(candidate.rules)) {
    throw new Error('The default safety policy has an invalid shape.');
  }

  const rules = candidate.rules.map((rule) => {
    if (!rule || typeof rule !== 'object' || typeof rule.id !== 'string' || typeof rule.pattern !== 'string'
      || typeof rule.category !== 'string' || typeof rule.severity !== 'string'
      || typeof rule.decision !== 'string' || typeof rule.message !== 'string') {
      throw new Error('The default safety policy contains an invalid rule.');
    }
    return {
      ...rule,
      matcher: new RegExp(rule.pattern, rule.flags ?? 'iu'),
    };
  });

  return { version: candidate.version, rules };
}

export function findPolicyMatches(policy: LoadedPolicy, text: string): StaticFinding[] {
  return policy.rules
    .filter((rule) => rule.matcher.test(text))
    .map((rule) => ({
      ruleId: rule.id,
      category: rule.category,
      severity: rule.severity,
      decision: rule.decision,
      message: rule.message,
    }));
}
