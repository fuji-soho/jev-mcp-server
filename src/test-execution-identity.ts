import { evaluationIdentity, type EvaluationConfigIdentity } from './config.js';
import type { EffectivePolicies } from './policy.js';
import { canonicalJson, buildFingerprint, EVALUATOR_VERSION, fileDigest, projectId, sha256, testInputIdentity, type TestFileIdentity } from './safety-fingerprint.js';
import { validateExecutionSelection, type ExecutionSelectionResult, type SafetyProfileResult } from './test-safety-profile.js';
import type { TestCheckInput } from './types.js';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_COMMAND_LENGTH = 16_000;
const MAX_TEST_CODE_LENGTH = 64_000;
const MAX_DIFF_LENGTH = 64_000;
const MAX_CONTEXT_LENGTH = 32_000;
const MAX_FIELD_LENGTH = 4_000;

export interface TestEvaluationIdentity {
  root: string;
  projectId: string;
  modelVersion: string;
  dependencyFingerprint: string;
  contextHash: string;
  runtimeHash: string;
  fingerprint: string;
  executionSelection: ExecutionSelectionResult;
}

export function validateTestInput(input: TestCheckInput): string | undefined {
  if (input.command.trim() === '') return 'command must not be empty.';
  if (input.command.length > MAX_COMMAND_LENGTH) return `command exceeds the ${MAX_COMMAND_LENGTH}-character limit.`;
  if (input.testCode !== undefined && input.testCode.length > MAX_TEST_CODE_LENGTH) return `testCode exceeds the ${MAX_TEST_CODE_LENGTH}-character limit.`;
  if (input.diff !== undefined && input.diff.length > MAX_DIFF_LENGTH) return `diff exceeds the ${MAX_DIFF_LENGTH}-character limit.`;
  if (input.context !== undefined && input.context.length > MAX_CONTEXT_LENGTH) return `context exceeds the ${MAX_CONTEXT_LENGTH}-character limit.`;
  for (const [name, value] of [['cwd', input.cwd], ['framework', input.framework]] as const) if (value !== undefined && value.length > MAX_FIELD_LENGTH) return `${name} exceeds the ${MAX_FIELD_LENGTH}-character limit.`;
  return undefined;
}

export function sharedSafetyFiles(root: string): Array<{ key: string; digest: string; bytes: number }> {
  const candidates = ['tests/TestCase.php', 'test-safe.php', 'phpunit.xml', 'phpunit.xml.dist', 'package.json', 'pyproject.toml', 'pytest.ini', 'vitest.config.ts', 'vitest.config.js', '.jev/test-safety.json'];
  return candidates.map((file) => fileDigest(root, file)).filter((item): item is { key: string; digest: string; bytes: number } => item !== undefined);
}

export function buildTestEvaluationIdentity(
  config: EvaluationConfigIdentity,
  input: TestCheckInput,
  targetKey: string,
  policies: EffectivePolicies,
  safety: SafetyProfileResult,
  fileIdentity?: TestFileIdentity,
): TestEvaluationIdentity {
  const root = (() => { try { return realpathSync(resolve(input.cwd ?? process.cwd())); } catch { return resolve(input.cwd ?? process.cwd()); } })();
  const pid = projectId(root);
  const executionSelection: ExecutionSelectionResult = safety.profileV2 === undefined
    ? { valid: true, runnerMatched: true, selectorsAllowed: true }
    : validateExecutionSelection(root, safety.profileV2, input.execution, input.testFiles, input.command, input.framework, input.environment);
  const sharedFiles = sharedSafetyFiles(root);
  const dependencyFingerprint = safety.assessment.dependencyFingerprint ?? sha256(canonicalJson(sharedFiles));
  const contextHash = sha256(canonicalJson({ shared: { safety: safety.jevContext, policyVersion: policies.version, policyHash: policies.hash, files: sharedFiles, dependencyFingerprint }, runtime: input.runtime, isolation: input.isolation, database: input.runtimeDatabase, configCache: input.configCache, guard: input.runtimeGuard }));
  const runtimeHash = sha256(canonicalJson({ runtime: input.runtime, isolation: input.isolation, database: input.runtimeDatabase, configCache: input.configCache, guard: input.runtimeGuard, persistentDatabaseAccess: input.persistentDatabaseAccess }));
  const testSpecific = testInputIdentity(input, fileIdentity, safety.profileV2 !== undefined);
  const modelVersion = evaluationIdentity(config);
  const fingerprint = buildFingerprint({ projectId: pid, targetType: 'test-file', targetKey, testSpecific, sharedContext: { safety: safety.jevContext, policyHash: policies.hash, profile: safety.assessment, files: sharedFiles, dependencyFingerprint }, policyHash: policies.hash, contextHash, safetyProfileHash: safety.assessment.profileDigest, runtimeHash, modelVersion, evaluatorVersion: EVALUATOR_VERSION });
  return { root, projectId: pid, modelVersion, dependencyFingerprint, contextHash, runtimeHash, fingerprint, executionSelection };
}
