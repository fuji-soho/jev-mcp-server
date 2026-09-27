import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { TestCheckInput, SafetyProfileAssessment } from './types.js';

const PROFILE_VERSION = 1;
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 128;
const DEFAULT_PROFILE = '.jev/test-safety.json';
const STATE_ENV = 'JEV_TEST_SAFETY_STATE_PATH';
const STATE_DIR_ENV = 'JEV_TEST_SAFETY_STATE_DIR';

interface SafetyProfile {
  version: 1;
  name: string;
  framework?: string;
  runner?: { commands?: string[]; files?: string[] };
  safetyFiles: string[];
  expected?: {
    environment?: string;
    database?: Record<string, unknown>;
    isolation?: Record<string, unknown>;
    runtime?: Record<string, unknown>;
  };
  externalResources?: { policy?: 'deny' | 'mocked' | 'allow'; allowedHosts?: string[] };
}

interface SafetyState {
  version: 1;
  projectId: string;
  profileDigest: string;
  safetyFingerprint: string;
  runtimeFingerprint: string;
  verifiedAt: string;
}

export interface SafetyProfileResult {
  assessment: SafetyProfileAssessment;
  jevContext: Record<string, unknown>;
}

function sha256(value: string | Buffer): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function safeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  return normalized !== '.' && !normalized.split('/').includes('..') && !normalized.startsWith('/');
}
function withinRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function readRegularFile(path: string, maxBytes: number): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Safety Profile path is not a regular file or is too large.');
  return readFileSync(path);
}
function parseProfile(value: unknown): SafetyProfile {
  if (!isRecord(value) || value.version !== PROFILE_VERSION || typeof value.name !== 'string' || value.name.length === 0 || !Array.isArray(value.safetyFiles)) throw new Error('Invalid Safety Profile schema or unsupported version.');
  if (value.safetyFiles.length === 0 || value.safetyFiles.length > MAX_FILES || value.safetyFiles.some((item) => !safeRelativePath(item))) throw new Error('Safety Profile contains invalid safetyFiles.');
  const runner = value.runner;
  if (runner !== undefined && (!isRecord(runner) || (runner.commands !== undefined && (!Array.isArray(runner.commands) || runner.commands.some((item) => typeof item !== 'string'))) || (runner.files !== undefined && (!Array.isArray(runner.files) || runner.files.some((item) => !safeRelativePath(item))))) ) throw new Error('Safety Profile contains an invalid runner.');
  const external = value.externalResources;
  if (external !== undefined && (!isRecord(external) || (external.policy !== undefined && !['deny', 'mocked', 'allow'].includes(String(external.policy))) || (external.allowedHosts !== undefined && (!Array.isArray(external.allowedHosts) || external.allowedHosts.some((item) => typeof item !== 'string'))))) throw new Error('Safety Profile contains invalid external resource policy.');
  return value as unknown as SafetyProfile;
}
function canonicalProfile(profile: SafetyProfile): string { return JSON.stringify(profile, Object.keys(profile).sort()); }
function runtimeShape(input: TestCheckInput): Record<string, unknown> {
  return {
    environment: input.environment ?? 'unknown', framework: input.framework ?? null,
    command: input.command,
    runtime: input.runtime ?? null, isolation: input.isolation ?? null,
    runtimeDatabase: input.runtimeDatabase ?? null, configCache: input.configCache ?? null,
    runtimeGuard: input.runtimeGuard ?? null, persistentDatabaseAccess: input.persistentDatabaseAccess ?? null,
  };
}
function expectedMatches(profile: SafetyProfile, input: TestCheckInput): boolean {
  const expected = profile.expected;
  if (!expected) return false;
  if (expected.environment !== undefined && expected.environment !== input.environment) return false;
  if (profile.framework !== undefined && profile.framework.toLowerCase() !== (input.framework ?? '').toLowerCase()) return false;
  const groups: Array<[Record<string, unknown> | undefined, Record<string, unknown> | undefined]> = [
    [expected.database, input.runtimeDatabase as unknown as Record<string, unknown> | undefined],
    [expected.isolation, input.isolation as unknown as Record<string, unknown> | undefined],
    [expected.runtime, input.runtime as unknown as Record<string, unknown> | undefined],
  ];
  return groups.every(([wanted, actual]) => wanted === undefined || (actual !== undefined && Object.entries(wanted).every(([key, value]) => actual[key] === value)))
    && (profile.externalResources?.policy !== 'deny' || input.runtime?.networkAccess !== true);
}
function statePath(root: string, environment: NodeJS.ProcessEnv): string {
  const explicit = environment[STATE_ENV]?.trim();
  if (explicit) return resolve(explicit);
  const dir = environment[STATE_DIR_ENV]?.trim() || join(environment.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'jev-mcp', 'test-safety-state');
  return join(dir, `${sha256(resolve(root)).slice('sha256:'.length)}.json`);
}

export function assessSafetyProfile(input: TestCheckInput, environment: NodeJS.ProcessEnv = process.env): SafetyProfileResult {
  const root = resolve(input.cwd ?? process.cwd());
  const profilePath = input.safetyProfilePath ? resolve(input.safetyProfilePath) : join(root, DEFAULT_PROFILE);
  if (!withinRoot(root, profilePath)) return { assessment: { status: 'invalid', profilePath, fingerprintMatched: false, runtimeMatched: false, reason: 'Safety Profile must be inside the project root.' }, jevContext: { status: 'invalid' } };
  let profileBytes: Buffer;
  try { profileBytes = readRegularFile(profilePath, MAX_PROFILE_BYTES); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { assessment: { status: 'absent', fingerprintMatched: false, runtimeMatched: false }, jevContext: { status: 'absent' } };
    return { assessment: { status: 'invalid', profilePath, fingerprintMatched: false, runtimeMatched: false, reason: 'Safety Profile could not be read.' }, jevContext: { status: 'invalid' } };
  }
  let profile: SafetyProfile;
  try { profile = parseProfile(JSON.parse(profileBytes.toString('utf8')) as unknown); } catch (error) {
    return { assessment: { status: 'invalid', profilePath, fingerprintMatched: false, runtimeMatched: false, reason: error instanceof Error ? error.message : 'Invalid Safety Profile.' }, jevContext: { status: 'invalid' } };
  }
  const paths = [...new Set([...profile.safetyFiles, ...(profile.runner?.files ?? [])])].sort();
  if (paths.length > MAX_FILES) return { assessment: { status: 'invalid', profilePath, profileName: profile.name, fingerprintMatched: false, runtimeMatched: false, reason: 'Safety Profile has too many fingerprint files.' }, jevContext: { status: 'invalid' } };
  const manifest: string[] = [];
  try {
    for (const rel of paths) {
      const absolute = resolve(root, rel);
      if (!withinRoot(root, absolute)) throw new Error('Safety Profile path escapes project root.');
      const bytes = readRegularFile(absolute, MAX_FILE_BYTES);
      manifest.push(`${rel.replaceAll('\\', '/')}\0${bytes.byteLength}\0${sha256(bytes)}\0`);
    }
  } catch (error) {
    return { assessment: { status: 'changed', profilePath, profileName: profile.name, fingerprintMatched: false, runtimeMatched: false, reason: error instanceof Error ? error.message : 'Safety file is unavailable.' }, jevContext: { status: 'changed', profileName: profile.name } };
  }
  const profileDigest = sha256(canonicalProfile(profile));
  const safetyFingerprint = sha256(manifest.join(''));
  const runtimeFingerprint = sha256(JSON.stringify(runtimeShape(input)));
  let state: SafetyState | undefined;
  try { state = JSON.parse(readRegularFile(statePath(root, environment), MAX_PROFILE_BYTES).toString('utf8')) as SafetyState; } catch { state = undefined; }
  const fingerprintMatched = state?.profileDigest === profileDigest && state.safetyFingerprint === safetyFingerprint;
  const runtimeMatched = state?.runtimeFingerprint === runtimeFingerprint && expectedMatches(profile, input);
  const status: SafetyProfileAssessment['status'] = state === undefined ? 'unverified' : fingerprintMatched && runtimeMatched ? 'verified' : 'changed';
  const assessment: SafetyProfileAssessment = { status, profilePath, profileName: profile.name, fingerprintMatched, runtimeMatched, profileDigest, safetyFingerprint, ...(status === 'verified' ? {} : { reason: 'Profile, safety files, or runtime context differs from the verified state.' }) };
  return { assessment, jevContext: { status, profileName: profile.name, fingerprintMatched, runtimeMatched, runtimeExpected: expectedMatches(profile, input), profileDigest, safetyFingerprint, runtimeFingerprint, projectId: sha256(root), expected: profile.expected ?? null, externalResources: profile.externalResources ?? null } };
}

export function verifySafetyProfile(input: TestCheckInput, environment: NodeJS.ProcessEnv = process.env): SafetyProfileAssessment {
  const result = assessSafetyProfile(input, environment);
  if (result.assessment.status === 'absent' || result.assessment.status === 'invalid' || !result.jevContext.profileDigest || !result.jevContext.safetyFingerprint || !result.jevContext.runtimeFingerprint || !result.jevContext.projectId) {
    throw new Error(result.assessment.reason ?? 'A valid Safety Profile and all safety files are required.');
  }
  if (result.jevContext.runtimeExpected !== true) {
    throw new Error('The current runtime context does not match the Safety Profile expected values.');
  }
  const root = resolve(input.cwd ?? process.cwd());
  const path = statePath(root, environment);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const state: SafetyState = {
    version: 1,
    projectId: String(result.jevContext.projectId),
    profileDigest: String(result.jevContext.profileDigest),
    safetyFingerprint: String(result.jevContext.safetyFingerprint),
    runtimeFingerprint: String(result.jevContext.runtimeFingerprint),
    verifiedAt: new Date().toISOString(),
  };
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { ...result.assessment, status: 'verified', fingerprintMatched: true, runtimeMatched: true };
}
