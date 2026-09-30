import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { TestCheckInput, TestFileError } from './types.js';

export const FINGERPRINT_SCHEMA_VERSION = 2;
export const EVALUATOR_VERSION = 'jev-mcp-server@1.1.0:approval-model-v1:raw-test-input-v1';

function normalize(value: unknown): unknown {
  if (typeof value === 'string') return value.replaceAll('\\r\\n', '\\n').replaceAll('\\r', '\\n').normalize('NFC');
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
}

export function canonicalJson(value: unknown): string { return JSON.stringify(normalize(value)); }
export function sha256(value: string | Buffer): string { return `sha256:${createHash('sha256').update(value).digest('hex')}`; }

export interface TestFileIdentity { digest: string; bytes: number; }

/** Hash before redaction or canonical normalization; never include raw input in the returned identity. */
export function testInputIdentity(input: TestCheckInput, file?: TestFileIdentity, profileV2 = false): unknown {
  const digest = (value: string | undefined): string | null => value === undefined ? null : sha256(Buffer.from(value, 'utf8'));
  return {
    schemaVersion: 1,
    source: file === undefined ? { kind: 'inline', digest: digest(input.testCode) } : { kind: 'file', digest: file.digest, bytes: file.bytes },
    diff: digest(input.diff),
    framework: digest(input.framework),
    context: digest(input.context),
    // Profile v2 separates runner/selection identity from reusable code evaluation.
    ...(profileV2 ? {} : { command: digest(input.command), environment: digest(input.environment) }),
  };
}

export function projectId(root: string): string { return sha256(resolve(root)); }

export interface FingerprintInput {
  projectId: string;
  targetType: string;
  targetKey: string;
  testSpecific?: unknown;
  sharedContext?: unknown;
  policyHash: string;
  contextHash: string;
  safetyProfileHash?: string | undefined;
  runtimeHash: string;
  modelVersion: string;
  evaluatorVersion: string;
}

export function buildFingerprint(input: FingerprintInput): string {
  return sha256(canonicalJson({ schemaVersion: FINGERPRINT_SCHEMA_VERSION, ...input }));
}

export function relativeTarget(root: string, file: string): string | undefined {
  const absolute = resolve(root, file);
  const rel = relative(resolve(root), absolute);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? undefined : rel.replaceAll('\\', '/');
}

export function fileDigest(root: string, file: string): { key: string; digest: string; bytes: number } | undefined {
  const key = relativeTarget(root, file);
  if (!key) return undefined;
  try {
    const path = resolve(root, key);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    if (relativeTarget(realpathSync(root), realpathSync(path)) === undefined) return undefined;
    const contents = readFileSync(path);
    return { key, digest: sha256(contents), bytes: contents.byteLength };
  } catch { return undefined; }
}

export type TestRootResolution =
  | { ok: true; root: string }
  | { ok: false; code: 'TEST_CWD_NOT_FOUND' | 'TEST_CWD_NOT_DIRECTORY' | 'TEST_CWD_UNREADABLE'; message: string };

export type TestFileResolution =
  | { ok: true; target: string; content: string; digest: string; bytes: number }
  | { ok: false; error: TestFileError };

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}

export function resolveTestRoot(root: string): TestRootResolution {
  const requested = resolve(root);
  try {
    const actual = realpathSync(requested);
    if (!lstatSync(actual).isDirectory()) return { ok: false, code: 'TEST_CWD_NOT_DIRECTORY', message: 'cwd is not a directory in the MCP server filesystem.' };
    return { ok: true, root: actual };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { ok: false, code: 'TEST_CWD_NOT_FOUND', message: 'cwd does not exist in the MCP server filesystem.' };
    if (errorCode(error) === 'ENOTDIR') return { ok: false, code: 'TEST_CWD_NOT_DIRECTORY', message: 'cwd is not a directory in the MCP server filesystem.' };
    return { ok: false, code: 'TEST_CWD_UNREADABLE', message: 'cwd could not be read from the MCP server filesystem.' };
  }
}

/** Resolve and read an explicitly requested test file without following a file symlink. */
export function readTestFile(root: string, file: string): TestFileResolution {
  const target = relativeTarget(root, file);
  if (target === undefined) return { ok: false, error: { file, code: 'TEST_FILE_OUTSIDE_CWD', message: 'The requested test file resolves outside cwd in the MCP server filesystem.' } };
  const path = resolve(root, target);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return { ok: false, error: { file, code: 'TEST_FILE_SYMLINK', message: 'The requested test file must not be a symbolic link.' } };
    if (!stat.isFile()) return { ok: false, error: { file, code: 'TEST_FILE_NOT_REGULAR', message: 'The requested test file is not a regular file.' } };
    const actual = realpathSync(path);
    if (relativeTarget(root, actual) === undefined) return { ok: false, error: { file, code: 'TEST_FILE_OUTSIDE_CWD', message: 'The requested test file resolves outside cwd in the MCP server filesystem.' } };
    const contents = readFileSync(actual);
    return { ok: true, target, content: contents.toString('utf8'), digest: sha256(contents), bytes: contents.byteLength };
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { ok: false, error: { file, code: 'TEST_FILE_NOT_FOUND', message: 'The requested test file does not exist under cwd in the MCP server filesystem.' } };
    return { ok: false, error: { file, code: 'TEST_FILE_UNREADABLE', message: 'The requested test file could not be read from the MCP server filesystem.' } };
  }
}

const MAX_MANIFEST_FILES = 20_000;
const MAX_MANIFEST_FILE_BYTES = 8 * 1024 * 1024;

export interface FileManifestEntry { key: string; digest: string; bytes: number; }

/** Build a deterministic, symlink-free manifest for explicitly configured files or directories. */
export function digestPaths(root: string, configuredPaths: string[]): { fingerprint: string; files: FileManifestEntry[] } {
  const resolvedRoot = realpathSync(resolve(root));
  const files: FileManifestEntry[] = [];
  const visit = (relativePath: string): void => {
    const key = relativeTarget(resolvedRoot, relativePath);
    if (key === undefined || key === '') throw new Error('Configured fingerprint path escapes the project root.');
    const absolute = resolve(resolvedRoot, key);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Configured fingerprint path must not be a symbolic link: ${key}`);
    if (stat.isDirectory()) {
      for (const child of readdirSync(absolute).sort()) visit(`${key}/${child}`);
      return;
    }
    if (!stat.isFile()) throw new Error(`Configured fingerprint path is not a regular file: ${key}`);
    if (stat.size > MAX_MANIFEST_FILE_BYTES) throw new Error(`Configured fingerprint file is too large: ${key}`);
    const actual = realpathSync(absolute);
    if (relativeTarget(resolvedRoot, actual) === undefined) throw new Error(`Configured fingerprint path escapes the project root: ${key}`);
    const contents = readFileSync(actual);
    files.push({ key: key.replaceAll('\\', '/'), digest: sha256(contents), bytes: contents.byteLength });
    if (files.length > MAX_MANIFEST_FILES) throw new Error('Configured fingerprint paths contain too many files.');
  };
  for (const configuredPath of [...new Set(configuredPaths)].sort()) visit(configuredPath.replaceAll('\\', '/'));
  files.sort((a, b) => a.key.localeCompare(b.key));
  return { fingerprint: sha256(canonicalJson(files)), files };
}
