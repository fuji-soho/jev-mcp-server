import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const FINGERPRINT_SCHEMA_VERSION = 2;
export const EVALUATOR_VERSION = 'jev-mcp-server@1.1.0';
export const MODEL_VERSION = process.env.JEV_MODEL_VERSION?.trim() || 'typesafe/jev';

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
