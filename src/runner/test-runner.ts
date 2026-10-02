import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EvaluationConfigIdentity } from '../config.js';
import { loadEffectiveTestPolicies } from '../policy.js';
import { canonicalJson, projectId, readTestFile, resolveTestRoot, sha256 } from '../safety-fingerprint.js';
import { openDatabase } from '../storage/sqlite.js';
import { consumeExecutionTicketForIdentity, invalidateExecutionTicket, type ExecutionTicketConsumeStatus } from '../storage/execution-ticket.js';
import { buildTestEvaluationIdentity, validateTestInput } from '../test-execution-identity.js';
import { assessSafetyProfile, validateExecutionSelection, type SafetyProfileV2 } from '../test-safety-profile.js';
import type { TestCheckInput, TestExecutionSelection } from '../types.js';

export interface RuntimeDatabaseObservation {
  connection: string;
  database: string;
  temporary: boolean;
}

export interface RuntimeEnforcement {
  immutableWorkspace: true;
  configCacheActive: false;
  database: {
    primary?: RuntimeDatabaseObservation;
    fallbackConnections: string[];
    additionalConnections: string[];
  };
  filesystem: { enforced: true; writableRoots: string[] };
  network: { enforced: true; policy: 'deny' | 'allowlist'; allowedHosts: string[] };
  credentials: { enforced: true; policy: 'deny' | 'allowlist'; allowedNames: string[] };
}

export interface ApprovedExecutionPlan {
  root: string;
  runnerId: string;
  executable: string;
  fixedArgs: string[];
  files: string[];
  filter?: string;
  shell: false;
}

export interface ApprovedRunnerAdapter<TResult> {
  /** Establish immutable source and resource controls before identity is recomputed. */
  prepare(context: { root: string; profile: SafetyProfileV2; selection: TestExecutionSelection }): Promise<RuntimeEnforcement>;
  /** Execute only this plan, in the same controls established by prepare. Never use a shell. */
  execute(context: { plan: ApprovedExecutionPlan; enforcement: RuntimeEnforcement }): Promise<TResult>;
}

export interface RunApprovedTestOptions<TResult> {
  ticket: string;
  config: EvaluationConfigIdentity;
  input: TestCheckInput;
  adapter: ApprovedRunnerAdapter<TResult>;
}

export class ApprovedTestExecutionError extends Error {
  public constructor(public readonly code: string, message: string) { super(message); this.name = 'ApprovedTestExecutionError'; }
}

interface CurrentIdentity {
  root: string;
  profile: SafetyProfileV2;
  profileDigest: string;
  projectId: string;
  environmentFingerprint: string;
  codeFingerprint: string;
  executionFingerprint: string;
  files: string[];
}

function fail(code: string, message: string): never { throw new ApprovedTestExecutionError(code, message); }
function normalized(values: string[]): string[] { return [...new Set(values)].sort(); }
function isSubset(actual: string[], approved: string[]): boolean { const allowed = new Set(approved); return actual.every((value) => allowed.has(value)); }

function validateEnforcement(profile: SafetyProfileV2, enforcement: RuntimeEnforcement): void {
  if (enforcement.immutableWorkspace !== true) fail('WORKSPACE_NOT_IMMUTABLE', 'The runner did not establish an immutable workspace.');
  if (enforcement.configCacheActive !== false) fail('CONFIG_CACHE_ACTIVE', 'The effective configuration cache is active.');
  if (enforcement.database.fallbackConnections.length !== 0 || enforcement.database.additionalConnections.length !== 0) fail('DATABASE_SCOPE_MISMATCH', 'Fallback or additional database connections are available.');
  const database = enforcement.database.primary;
  if (profile.resources.database.policy === 'deny' && database !== undefined) fail('DATABASE_SCOPE_MISMATCH', 'A database connection is available although the profile denies database access.');
  if (profile.resources.database.policy === 'sqlite-memory' && database !== undefined && !(database.connection === 'sqlite' && database.database === ':memory:' && database.temporary)) fail('DATABASE_SCOPE_MISMATCH', 'The effective database is not isolated SQLite memory.');
  if (profile.resources.database.policy === 'temporary-only' && database !== undefined && !database.temporary) fail('DATABASE_SCOPE_MISMATCH', 'The effective database is not temporary.');
  if (enforcement.filesystem.enforced !== true || !isSubset(normalized(enforcement.filesystem.writableRoots), normalized(profile.resources.filesystem.writableRoots))) fail('FILESYSTEM_SCOPE_MISMATCH', 'Writable filesystem roots exceed the approved profile.');
  const approvedHosts = normalized(profile.resources.network.allowedHosts ?? []);
  const networkPolicyAllowed = enforcement.network.policy === 'deny' || (profile.resources.network.policy === 'allowlist' && enforcement.network.policy === 'allowlist');
  if (enforcement.network.enforced !== true || !networkPolicyAllowed || !isSubset(normalized(enforcement.network.allowedHosts), approvedHosts)) fail('NETWORK_SCOPE_MISMATCH', 'Network access exceeds the approved profile.');
  const approvedNames = normalized(profile.resources.credentials.allowedNames ?? []);
  const credentialPolicyAllowed = enforcement.credentials.policy === 'deny' || (profile.resources.credentials.policy === 'allowlist' && enforcement.credentials.policy === 'allowlist');
  if (enforcement.credentials.enforced !== true || !credentialPolicyAllowed || !isSubset(normalized(enforcement.credentials.allowedNames), approvedNames)) fail('CREDENTIAL_SCOPE_MISMATCH', 'Credential access exceeds the approved profile.');
}

function buildCurrentIdentity(config: EvaluationConfigIdentity, input: TestCheckInput): CurrentIdentity {
  const validationError = validateTestInput(input);
  if (validationError !== undefined) fail('INVALID_INPUT', validationError);
  if (input.testFiles === undefined || input.testFiles.length === 0) fail('TEST_FILES_REQUIRED', 'Ticket execution requires explicit testFiles.');
  const rootResult = resolveTestRoot(input.cwd ?? process.cwd());
  if (!rootResult.ok) fail(rootResult.code, rootResult.message);
  const root = rootResult.root;
  const safety = assessSafetyProfile({ ...input, cwd: root });
  if (safety.profileV2 === undefined || safety.assessment.profileDigest === undefined || safety.assessment.environmentFingerprint === undefined) fail('PROFILE_V2_REQUIRED', 'Ticket execution requires a complete Safety Profile v2.');
  if (safety.relatedCode?.status === 'incomplete') fail('RELATED_CODE_REVIEW_INCOMPLETE', safety.relatedCode.reason);
  const selection = validateExecutionSelection(root, safety.profileV2, input.execution, input.testFiles, input.command, input.framework, input.environment);
  if (!selection.valid || selection.executionFingerprint === undefined || input.execution === undefined) fail('INVALID_EXECUTION_SELECTION', selection.reason ?? 'The execution selection is invalid.');
  const files = input.testFiles.map((file) => readTestFile(root, file));
  const invalid = files.find((file) => !file.ok);
  if (invalid && !invalid.ok) fail(invalid.error.code, invalid.error.message);
  const policies = loadEffectiveTestPolicies(root, input.framework);
  const fingerprints: string[] = [];
  const targets: string[] = [];
  for (const file of files) {
    if (!file.ok) continue;
    const identity = buildTestEvaluationIdentity(config, { ...input, cwd: root, testCode: file.content }, file.target, policies, safety, { digest: file.digest, bytes: file.bytes });
    if (!identity.executionSelection.valid || identity.executionSelection.executionFingerprint !== selection.executionFingerprint) fail('INVALID_EXECUTION_SELECTION', 'The current execution selection does not match the approved selection.');
    fingerprints.push(identity.fingerprint);
    targets.push(file.target);
  }
  return {
    root,
    profile: safety.profileV2,
    profileDigest: safety.assessment.profileDigest,
    projectId: projectId(root),
    environmentFingerprint: safety.assessment.environmentFingerprint,
    codeFingerprint: sha256(canonicalJson(fingerprints.sort())),
    executionFingerprint: selection.executionFingerprint,
    files: targets,
  };
}

function ticketFailure(status: ExecutionTicketConsumeStatus): never {
  fail(`TICKET_${status.replaceAll('-', '_').toUpperCase()}`, `The execution ticket could not be consumed: ${status}.`);
}

export async function runApprovedTest<TResult>(options: RunApprovedTestOptions<TResult>): Promise<TResult> {
  const now = (): string => new Date().toISOString();
  const revoke = (): void => { try { invalidateExecutionTicket(openDatabase(), options.ticket, now()); } catch { /* best effort */ } };
  if (!/^xtk_[A-Za-z0-9_-]{43}$/u.test(options.ticket)) fail('INVALID_TICKET', 'The execution ticket has an invalid format.');
  let preliminary;
  try {
    const root = realpathSync(resolve(options.input.cwd ?? process.cwd()));
    const safety = assessSafetyProfile({ ...options.input, cwd: root });
    if (safety.profileV2 === undefined || options.input.execution === undefined) fail('PROFILE_V2_REQUIRED', 'Ticket execution requires Safety Profile v2 and a structured execution selection.');
    const selection = validateExecutionSelection(root, safety.profileV2, options.input.execution, options.input.testFiles, options.input.command, options.input.framework, options.input.environment);
    if (!selection.valid) fail('INVALID_EXECUTION_SELECTION', selection.reason ?? 'The execution selection is invalid.');
    preliminary = { root, profile: safety.profileV2, profileDigest: safety.assessment.profileDigest, selection: options.input.execution };
  } catch (error) { revoke(); throw error; }
  let enforcement: RuntimeEnforcement;
  try {
    enforcement = await options.adapter.prepare({ root: preliminary.root, profile: preliminary.profile, selection: preliminary.selection });
    validateEnforcement(preliminary.profile, enforcement);
  } catch (error) {
    revoke();
    if (error instanceof ApprovedTestExecutionError) throw error;
    throw new ApprovedTestExecutionError('RUNTIME_PREPARATION_FAILED', 'The approved runner could not establish the required execution controls.');
  }
  let current: CurrentIdentity;
  try {
    current = buildCurrentIdentity(options.config, { ...options.input, cwd: preliminary.root });
    if (current.profileDigest !== preliminary.profileDigest) fail('ENVIRONMENT_CHANGED', 'The Safety Profile changed while the runner prepared the environment.');
  } catch (error) { revoke(); throw error; }
  const consumed = consumeExecutionTicketForIdentity(openDatabase(), options.ticket, {
    projectId: current.projectId,
    environmentFingerprint: current.environmentFingerprint,
    codeFingerprint: current.codeFingerprint,
    executionFingerprint: current.executionFingerprint,
  }, now());
  if (consumed.status !== 'consumed') ticketFailure(consumed.status);
  const selection = options.input.execution!;
  const plan: ApprovedExecutionPlan = {
    root: current.root,
    runnerId: selection.runnerId,
    executable: resolve(current.root, current.profile.runner.executable),
    fixedArgs: [...current.profile.runner.fixedArgs],
    files: [...current.files],
    ...(selection.filter === undefined ? {} : { filter: selection.filter }),
    shell: false,
  };
  return options.adapter.execute({ plan, enforcement });
}
