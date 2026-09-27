import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const FINGERPRINT_SCHEMA_VERSION = 1;
export const EVALUATOR_VERSION = 'jev-mcp-server@1.0.0';
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
    const contents = readFileSync(path);
    return { key, digest: sha256(contents), bytes: contents.byteLength };
  } catch { return undefined; }
}
