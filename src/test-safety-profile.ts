import { mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TestCheckInput, SafetyProfileAssessment, TestExecutionSelection } from './types.js';
import { canonicalJson, digestPaths, projectId, readRelatedCode, relativeTarget, sha256, type RelatedCodeSnapshot } from './safety-fingerprint.js';

const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 128;
const DEFAULT_PROFILE = '.jev/test-safety.json';
const STATE_ENV = 'JEV_TEST_SAFETY_STATE_PATH';
const STATE_DIR_ENV = 'JEV_TEST_SAFETY_STATE_DIR';
export const ENVIRONMENT_VERIFIER_VERSION = 'jev-environment-profile-v2@1';

interface SafetyProfileV1 {
  version: 1;
  name: string;
  framework?: string;
  runner?: { commands?: string[]; files?: string[] };
  safetyFiles: string[];
  expected?: { environment?: string; database?: Record<string, unknown>; isolation?: Record<string, unknown>; runtime?: Record<string, unknown> };
  externalResources?: { policy?: 'deny' | 'mocked' | 'allow'; allowedHosts?: string[] };
}

export interface SafetyProfileV2Runner {
  id: string;
  executable: string;
  files: string[];
  fixedArgs: string[];
  shell: false;
  selectors: { filePatterns: string[]; allowFilter: boolean };
}

export interface SafetyProfileV2 {
  version: 2;
  name: string;
  framework?: string;
  environment: 'testing';
  runner: SafetyProfileV2Runner;
  environmentFiles: string[];
  codeReviewRoots: string[];
  resources: {
    database: { policy: 'deny' | 'sqlite-memory' | 'temporary-only'; rejectFallback: true; rejectAdditionalConnections: true };
    filesystem: { writableRoots: string[] };
    network: { policy: 'deny' | 'allowlist'; allowedHosts?: string[] };
    credentials: { policy: 'deny' | 'allowlist'; allowedNames?: string[] };
  };
}

interface SafetyStateV1 { version: 1; projectId: string; profileDigest: string; safetyFingerprint: string; runtimeFingerprint: string; verifiedAt: string }

export interface SafetyProfileResult {
  assessment: SafetyProfileAssessment;
  jevContext: Record<string, unknown>;
  profileV2?: SafetyProfileV2;
  environmentScopeJson?: string;
  relatedCode?: RelatedCodeSnapshot;
  /** Internal, server-verified Profile v3 approval evidence. Never supplied by callers. */
  executionApproved?: boolean;
}

export interface ExecutionSelectionResult {
  valid: boolean;
  runnerMatched: boolean;
  selectorsAllowed: boolean;
  executionFingerprint?: string;
  reason?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function safeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  return normalized !== '.' && !normalized.split('/').includes('..') && !normalized.startsWith('/');
}
function safePathList(value: unknown, allowEmpty = false): value is string[] { return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= MAX_FILES && value.every(safeRelativePath); }
function withinRoot(root: string, path: string): boolean { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); }
function readRegularFile(path: string, maxBytes: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Safety Profile path is not a regular file or is too large.');
  return readFileSync(path);
}
function parseProfileV1(value: Record<string, unknown>): SafetyProfileV1 {
  if (typeof value.name !== 'string' || value.name.length === 0 || !safePathList(value.safetyFiles)) throw new Error('Invalid Safety Profile v1 schema.');
  const runner = value.runner;
  if (runner !== undefined && (!isRecord(runner) || (runner.commands !== undefined && (!Array.isArray(runner.commands) || runner.commands.some((item) => typeof item !== 'string'))) || (runner.files !== undefined && !safePathList(runner.files, true)))) throw new Error('Safety Profile contains an invalid runner.');
  const external = value.externalResources;
  if (external !== undefined && (!isRecord(external) || (external.policy !== undefined && !['deny', 'mocked', 'allow'].includes(String(external.policy))) || (external.allowedHosts !== undefined && (!Array.isArray(external.allowedHosts) || external.allowedHosts.some((item) => typeof item !== 'string'))))) throw new Error('Safety Profile contains invalid external resource policy.');
  return value as unknown as SafetyProfileV1;
}
function parseProfileV2(value: Record<string, unknown>): SafetyProfileV2 {
  if (typeof value.name !== 'string' || value.name.length === 0 || value.environment !== 'testing' || !isRecord(value.runner) || !isRecord(value.resources)) throw new Error('Invalid Safety Profile v2 schema.');
  const runner = value.runner;
  if (typeof runner.id !== 'string' || runner.id.trim() === '' || !safeRelativePath(runner.executable) || runner.shell !== false) throw new Error('Safety Profile v2 requires a project-relative non-shell runner.');
  if (!safePathList(runner.files) || !Array.isArray(runner.fixedArgs) || runner.fixedArgs.some((item) => typeof item !== 'string') || !isRecord(runner.selectors)) throw new Error('Safety Profile v2 contains an invalid runner.');
  if (!(runner.files as string[]).includes(runner.executable)) throw new Error('Safety Profile v2 runner executable must be fingerprinted in runner.files.');
  if (!safePathList(runner.selectors.filePatterns) || typeof runner.selectors.allowFilter !== 'boolean') throw new Error('Safety Profile v2 contains invalid selectors.');
  if (!safePathList(value.environmentFiles, true) || !safePathList(value.codeReviewRoots, true)) throw new Error('Safety Profile v2 contains invalid fingerprint paths.');
  const resources = value.resources;
  if (!isRecord(resources.database) || !['deny', 'sqlite-memory', 'temporary-only'].includes(String(resources.database.policy)) || resources.database.rejectFallback !== true || resources.database.rejectAdditionalConnections !== true) throw new Error('Safety Profile v2 requires a restrictive database policy and connection guards.');
  if (!isRecord(resources.filesystem) || !safePathList(resources.filesystem.writableRoots, true)) throw new Error('Safety Profile v2 contains an invalid filesystem scope.');
  if (!isRecord(resources.network) || !['deny', 'allowlist'].includes(String(resources.network.policy)) || (resources.network.allowedHosts !== undefined && (!Array.isArray(resources.network.allowedHosts) || resources.network.allowedHosts.some((item) => typeof item !== 'string')))) throw new Error('Safety Profile v2 contains an invalid network policy.');
  if (!isRecord(resources.credentials) || !['deny', 'allowlist'].includes(String(resources.credentials.policy)) || (resources.credentials.allowedNames !== undefined && (!Array.isArray(resources.credentials.allowedNames) || resources.credentials.allowedNames.some((item) => typeof item !== 'string')))) throw new Error('Safety Profile v2 contains an invalid credential policy.');
  return value as unknown as SafetyProfileV2;
}
function parseProfile(value: unknown): SafetyProfileV1 | SafetyProfileV2 {
  if (!isRecord(value)) throw new Error('Invalid Safety Profile schema.');
  if (value.version === 1) return parseProfileV1(value);
  if (value.version === 2) return parseProfileV2(value);
  throw new Error('Unsupported Safety Profile version.');
}
function runtimeShape(input: TestCheckInput): Record<string, unknown> {
  return { environment: input.environment ?? 'unknown', framework: input.framework ?? null, command: input.command, runtime: input.runtime ?? null, isolation: input.isolation ?? null, runtimeDatabase: input.runtimeDatabase ?? null, configCache: input.configCache ?? null, runtimeGuard: input.runtimeGuard ?? null, persistentDatabaseAccess: input.persistentDatabaseAccess ?? null };
}
function expectedMatches(profile: SafetyProfileV1, input: TestCheckInput): boolean {
  const expected = profile.expected;
  if (!expected) return false;
  if (expected.environment !== undefined && expected.environment !== input.environment) return false;
  if (profile.framework !== undefined && profile.framework.toLowerCase() !== (input.framework ?? '').toLowerCase()) return false;
  const groups: Array<[Record<string, unknown> | undefined, Record<string, unknown> | undefined]> = [[expected.database, input.runtimeDatabase as unknown as Record<string, unknown> | undefined], [expected.isolation, input.isolation as unknown as Record<string, unknown> | undefined], [expected.runtime, input.runtime as unknown as Record<string, unknown> | undefined]];
  return groups.every(([wanted, actual]) => wanted === undefined || (actual !== undefined && Object.entries(wanted).every(([key, item]) => actual[key] === item))) && (profile.externalResources?.policy !== 'deny' || input.runtime?.networkAccess !== true);
}
function statePath(root: string, environment: NodeJS.ProcessEnv): string {
  const explicit = environment[STATE_ENV]?.trim();
  if (explicit) return resolve(explicit);
  const dir = environment[STATE_DIR_ENV]?.trim() || join(environment.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'jev-mcp', 'test-safety-state');
  return join(dir, `${sha256(resolve(root)).slice('sha256:'.length)}.json`);
}
function invalidAssessment(reason: string, profilePath?: string): SafetyProfileResult {
  return { assessment: { status: 'invalid', ...(profilePath === undefined ? {} : { profilePath }), fingerprintMatched: false, runtimeMatched: false, reason }, jevContext: { status: 'invalid' } };
}

export function assessSafetyProfile(input: TestCheckInput, environment: NodeJS.ProcessEnv = process.env): SafetyProfileResult {
  const root = (() => { try { return realpathSync(resolve(input.cwd ?? process.cwd())); } catch { return resolve(input.cwd ?? process.cwd()); } })();
  const profilePath = input.safetyProfilePath ? resolve(input.safetyProfilePath) : join(root, DEFAULT_PROFILE);
  if (!withinRoot(root, profilePath)) return invalidAssessment('Safety Profile must be inside the project root.', profilePath);
  let profileBytes: Buffer;
  try { profileBytes = readRegularFile(profilePath, MAX_PROFILE_BYTES); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { assessment: { status: 'absent', fingerprintMatched: false, runtimeMatched: false }, jevContext: { status: 'absent' } };
    return invalidAssessment('Safety Profile could not be read.', profilePath);
  }
  let profile: SafetyProfileV1 | SafetyProfileV2;
  try { profile = parseProfile(JSON.parse(profileBytes.toString('utf8')) as unknown); } catch (error) { return invalidAssessment(error instanceof Error ? error.message : 'Invalid Safety Profile.', profilePath); }
  const profileDigest = sha256(canonicalJson(profile));
  if (profile.version === 2) {
    try {
      const environmentManifest = digestPaths(root, [...profile.environmentFiles, ...profile.runner.files]);
      const relatedCode = readRelatedCode(root, profile.codeReviewRoots);
      const dependency = relatedCode.status === 'complete' ? { dependencyFingerprint: relatedCode.fingerprint } : {};
      const pid = projectId(root);
      const environmentScope = { projectId: pid, projectRoot: root, profileDigest, framework: profile.framework ?? null, environment: profile.environment, runner: profile.runner, resources: profile.resources, environmentFilesFingerprint: environmentManifest.fingerprint };
      const environmentScopeJson = canonicalJson(environmentScope);
      const environmentFingerprint = sha256(environmentScopeJson);
      const assessment: SafetyProfileAssessment = { version: 2, status: 'unverified', profilePath, profileName: profile.name, fingerprintMatched: false, runtimeMatched: false, profileDigest, safetyFingerprint: environmentManifest.fingerprint, environmentFingerprint, ...dependency, runnerId: profile.runner.id, reason: 'Safety Profile v2 requires a matching Environment Approval.' };
      return { assessment, profileV2: profile, environmentScopeJson, relatedCode, jevContext: { status: 'unverified', version: 2, profileName: profile.name, profileDigest, environmentFingerprint, ...dependency, runnerId: profile.runner.id, resources: profile.resources, projectId: pid } };
    } catch (error) { return invalidAssessment(error instanceof Error ? error.message : 'Safety Profile v2 files could not be fingerprinted.', profilePath); }
  }
  const paths = [...new Set([...profile.safetyFiles, ...(profile.runner?.files ?? [])])].sort();
  if (paths.length > MAX_FILES) return invalidAssessment('Safety Profile has too many fingerprint files.', profilePath);
  const manifest: string[] = [];
  try {
    for (const rel of paths) {
      const absolute = resolve(root, rel);
      if (!withinRoot(root, absolute)) throw new Error('Safety Profile path escapes project root.');
      const bytes = readRegularFile(absolute, MAX_FILE_BYTES);
      manifest.push(`${rel.replaceAll('\\', '/')}\0${bytes.byteLength}\0${sha256(bytes)}\0`);
    }
  } catch (error) { return invalidAssessment(error instanceof Error ? error.message : 'Safety file is unavailable.', profilePath); }
  const safetyFingerprint = sha256(manifest.join(''));
  const runtimeFingerprint = sha256(canonicalJson(runtimeShape(input)));
  let state: SafetyStateV1 | undefined;
  try { state = JSON.parse(readRegularFile(statePath(root, environment), MAX_PROFILE_BYTES).toString('utf8')) as SafetyStateV1; } catch { state = undefined; }
  const currentProjectId = projectId(root);
  const fingerprintMatched = state?.version === 1 && state.projectId === currentProjectId && state.profileDigest === profileDigest && state.safetyFingerprint === safetyFingerprint;
  const runtimeMatched = state?.runtimeFingerprint === runtimeFingerprint && expectedMatches(profile, input);
  const status: SafetyProfileAssessment['status'] = state === undefined ? 'unverified' : fingerprintMatched && runtimeMatched ? 'verified' : 'changed';
  const assessment: SafetyProfileAssessment = { version: 1, status, profilePath, profileName: profile.name, fingerprintMatched, runtimeMatched, profileDigest, safetyFingerprint, ...(status === 'verified' ? {} : { reason: 'Profile, safety files, project, or runtime context differs from the verified state.' }) };
  return { assessment, jevContext: { status, version: 1, profileName: profile.name, fingerprintMatched, runtimeMatched, runtimeExpected: expectedMatches(profile, input), profileDigest, safetyFingerprint, runtimeFingerprint, projectId: currentProjectId, expected: profile.expected ?? null, externalResources: profile.externalResources ?? null } };
}

function globMatches(pattern: string, value: string): boolean {
  const placeholder = '__JEV_DOUBLE_STAR__';
  const escaped = pattern.replaceAll('**', placeholder).replace(/[.+^${}()|[\]\\]/gu, '\\$&').replaceAll('*', '[^/]*').replaceAll(placeholder, '.*');
  return new RegExp(`^${escaped}$`, 'u').test(value);
}

export function validateExecutionSelection(root: string, profile: SafetyProfileV2, selection: TestExecutionSelection | undefined, testFiles: string[] | undefined, command: string, framework: string | undefined, environment: string | undefined): ExecutionSelectionResult {
  if (selection === undefined) return { valid: false, runnerMatched: false, selectorsAllowed: false, reason: 'Safety Profile v2 requires a structured execution selection.' };
  const runnerMatched = selection.runnerId === profile.runner.id;
  if (!runnerMatched) return { valid: false, runnerMatched, selectorsAllowed: false, reason: 'The selected runner is not approved.' };
  if (profile.framework !== undefined && profile.framework.toLowerCase() !== (framework ?? '').toLowerCase()) return { valid: false, runnerMatched, selectorsAllowed: false, reason: 'The requested framework does not match the approved runner.' };
  if (environment !== profile.environment) return { valid: false, runnerMatched, selectorsAllowed: false, reason: 'The requested environment does not match the approved testing environment.' };
  if (command !== profile.runner.executable) return { valid: false, runnerMatched, selectorsAllowed: false, reason: 'Safety Profile v2 command must name only the approved runner; selectors must be structured.' };
  if (selection.files.length === 0 || selection.files.length > MAX_FILES) return { valid: false, runnerMatched, selectorsAllowed: false, reason: 'The execution selection must contain test files.' };
  const normalizedFiles: string[] = [];
  for (const file of selection.files) {
    const normalized = relativeTarget(root, file);
    if (normalized === undefined || normalized === '' || !profile.runner.selectors.filePatterns.some((pattern) => globMatches(pattern, normalized))) return { valid: false, runnerMatched, selectorsAllowed: false, reason: `Test selector is outside the approved scope: ${file}` };
    normalizedFiles.push(normalized);
  }
  if (new Set(normalizedFiles).size !== normalizedFiles.length) return { valid: false, runnerMatched, selectorsAllowed: false, reason: 'Duplicate test selectors are not permitted.' };
  if (selection.filter !== undefined && (!profile.runner.selectors.allowFilter || selection.filter.length === 0 || selection.filter.length > 1000 || /[\0\r\n]/u.test(selection.filter))) return { valid: false, runnerMatched, selectorsAllowed: false, reason: 'The test filter is not permitted by the approved runner.' };
  const normalizedTestFiles = (testFiles ?? []).map((file) => relativeTarget(root, file)).sort();
  if (normalizedTestFiles.some((file) => file === undefined) || canonicalJson([...normalizedFiles].sort()) !== canonicalJson(normalizedTestFiles)) return { valid: false, runnerMatched, selectorsAllowed: false, reason: 'Structured selectors and testFiles must identify the same files.' };
  return { valid: true, runnerMatched, selectorsAllowed: true, executionFingerprint: sha256(canonicalJson({ runnerId: selection.runnerId, files: [...normalizedFiles].sort(), filter: selection.filter ?? null })) };
}

export function verifySafetyProfile(input: TestCheckInput, environment: NodeJS.ProcessEnv = process.env): SafetyProfileAssessment {
  const result = assessSafetyProfile(input, environment);
  if (result.profileV2 !== undefined) throw new Error('Safety Profile v2 must be approved through the Environment Approval workflow.');
  if (result.assessment.status === 'absent' || result.assessment.status === 'invalid' || !result.jevContext.profileDigest || !result.jevContext.safetyFingerprint || !result.jevContext.runtimeFingerprint || !result.jevContext.projectId) throw new Error(result.assessment.reason ?? 'A valid Safety Profile and all safety files are required.');
  if (result.jevContext.runtimeExpected !== true) throw new Error('The current runtime context does not match the Safety Profile expected values.');
  const root = (() => { try { return realpathSync(resolve(input.cwd ?? process.cwd())); } catch { return resolve(input.cwd ?? process.cwd()); } })();
  const path = statePath(root, environment);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const state: SafetyStateV1 = { version: 1, projectId: String(result.jevContext.projectId), profileDigest: String(result.jevContext.profileDigest), safetyFingerprint: String(result.jevContext.safetyFingerprint), runtimeFingerprint: String(result.jevContext.runtimeFingerprint), verifiedAt: new Date().toISOString() };
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { ...result.assessment, status: 'verified', fingerprintMatched: true, runtimeMatched: true };
}
