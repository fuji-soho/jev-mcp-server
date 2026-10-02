import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { TestCheckInput, TestFileError } from './types.js';

export const FINGERPRINT_SCHEMA_VERSION = 2;
export const EVALUATOR_VERSION = 'jev-mcp-server@1.1.0:approval-model-v1:raw-test-input-v1:related-code-v1';

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

export const RELATED_CODE_LIMITS = { files: 64, fileBytes: 32 * 1024, totalBytes: 64 * 1024, entries: 4096 } as const;
export interface RelatedCodeFile extends FileManifestEntry { content: string; }
export type RelatedCodeSnapshot =
  | { status: 'complete'; fingerprint: string; files: RelatedCodeFile[] }
  | { status: 'incomplete'; reason: string; file?: string; files: RelatedCodeFile[] };

/** Read once: the original bytes identify the exact text inspected locally and sent (redacted) to Jev. */
export function readRelatedCode(root: string, configuredPaths: string[]): RelatedCodeSnapshot {
  const files: RelatedCodeFile[] = [];
  let totalBytes = 0;
  let entries = 0;
  const visited = new Set<string>();
  let currentFile: string | undefined;
  try {
    const resolvedRoot = realpathSync(resolve(root));
    const visit = (path: string): void => {
      const key = relativeTarget(resolvedRoot, path);
      if (!key || isAbsolute(path)) throw new Error('Related code path must be relative and inside the project root.');
      currentFile = key;
      if (visited.has(key)) return;
      visited.add(key);
      if (++entries > RELATED_CODE_LIMITS.entries) throw new Error('Related code exceeds the 4096-entry traversal limit.');
      // Also reject symlinks in parent components of explicitly configured paths.
      let component = resolvedRoot;
      for (const part of key.split('/')) {
        component = resolve(component, part);
        if (lstatSync(component).isSymbolicLink()) throw new Error('Related code contains a symbolic link.');
      }
      const absolute = resolve(resolvedRoot, key);
      const stat = lstatSync(absolute);
      if (relativeTarget(resolvedRoot, realpathSync(absolute)) === undefined) throw new Error('Related code escapes the project root.');
      if (stat.isDirectory()) {
        const children = readdirSync(absolute).sort();
        if (entries + children.length > RELATED_CODE_LIMITS.entries) throw new Error('Related code exceeds the 4096-entry traversal limit.');
        for (const child of children) visit(`${key}/${child}`);
        return;
      }
      if (!stat.isFile()) throw new Error('Related code is not a regular file.');
      if (files.length >= RELATED_CODE_LIMITS.files) throw new Error('Related code exceeds the 64-file limit.');
      if (stat.size > RELATED_CODE_LIMITS.fileBytes) throw new Error('Related code exceeds the 32 KiB per-file limit.');
      const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let contents: Buffer;
      try {
        const opened = fstatSync(fd);
        if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('Related code changed while being opened.');
        const buffer = Buffer.alloc(RELATED_CODE_LIMITS.fileBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, null);
          if (count === 0) break;
          length += count;
        }
        if (length > RELATED_CODE_LIMITS.fileBytes) throw new Error('Related code exceeds the 32 KiB per-file limit.');
        const after = fstatSync(fd);
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || relativeTarget(resolvedRoot, realpathSync(absolute)) === undefined) throw new Error('Related code changed while being read.');
        contents = buffer.subarray(0, length);
      } finally { closeSync(fd); }
      if (totalBytes + contents.byteLength > RELATED_CODE_LIMITS.totalBytes) throw new Error('Related code exceeds the 64 KiB total limit.');
      if (contents.includes(0)) throw new Error('Related code contains binary content.');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents); }
      catch { throw new Error('Related code is not valid UTF-8.'); }
      if (/[\x01-\x08\x0b\x0e-\x1f\x7f]/u.test(content)) throw new Error('Related code contains binary content.');
      totalBytes += contents.byteLength;
      files.push({ key, digest: sha256(contents), bytes: contents.byteLength, content });
    };
    for (const path of [...new Set(configuredPaths)].sort()) visit(path.replaceAll('\\', '/'));
    files.sort((a, b) => a.key.localeCompare(b.key));
    return { status: 'complete', files, fingerprint: sha256(canonicalJson({ version: 'related-code-v1', limits: RELATED_CODE_LIMITS, files: files.map(({ key, digest, bytes }) => ({ key, digest, bytes })) })) };
  } catch (error) {
    // Never return OS errors containing absolute paths or file contents.
    const reason = error instanceof Error && error.message.startsWith('Related code') ? error.message : 'Related code could not be read completely.';
    return { status: 'incomplete', files, reason, ...(currentFile ? {file:currentFile} : {}) };
  }
}

/** Build a deterministic, symlink-free manifest for explicitly configured files or directories. */
export function digestPaths(root: string, configuredPaths: string[]): { fingerprint: string; files: FileManifestEntry[] } {
  const resolvedRoot = realpathSync(resolve(root));
  const files: FileManifestEntry[] = [];
  let entries = 0;
  const visit = (relativePath: string): void => {
    if (++entries > 40_000) throw new Error('Configured fingerprint paths exceed the traversal limit.');
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
