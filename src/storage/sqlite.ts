import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DB_PATH = join(PROJECT_ROOT, 'cache', 'jev.sqlite');
export const CURRENT_SCHEMA_VERSION = 1;

let shared: DatabaseSync | undefined;
let sharedPath: string | undefined;

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value?: string } | undefined;
  const version = row?.value === undefined ? 0 : Number(row.value);
  if (!Number.isInteger(version) || version > CURRENT_SCHEMA_VERSION) throw new Error('Unsupported SQLite schema version.');
  if (version === 0) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS fingerprint_cache (
        id INTEGER PRIMARY KEY,
        project_id TEXT NOT NULL, target_type TEXT NOT NULL, target_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, policy_hash TEXT NOT NULL, context_hash TEXT NOT NULL,
        safety_profile_hash TEXT, runtime_hash TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('allow', 'review', 'deny')),
        reusable INTEGER NOT NULL DEFAULT 0 CHECK (reusable IN (0, 1)),
        model_version TEXT NOT NULL, evaluator_version TEXT NOT NULL,
        verified_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (project_id, target_type, target_key, fingerprint, policy_hash, context_hash, runtime_hash, model_version, evaluator_version)
      );
      CREATE INDEX IF NOT EXISTS idx_fingerprint_lookup ON fingerprint_cache(project_id, target_type, target_key, fingerprint, policy_hash, context_hash, runtime_hash, model_version, evaluator_version);
      CREATE INDEX IF NOT EXISTS idx_fingerprint_updated ON fingerprint_cache(updated_at);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL, request_id TEXT NOT NULL, project_id TEXT,
        tool_name TEXT NOT NULL, target_type TEXT, target_key TEXT, fingerprint TEXT,
        cache_status TEXT NOT NULL CHECK (cache_status IN ('disabled', 'miss', 'hit', 'stale', 'error')),
        static_decision TEXT CHECK (static_decision IN ('allow', 'review', 'deny')),
        jev_decision TEXT CHECK (jev_decision IN ('allow', 'review', 'deny')),
        final_decision TEXT NOT NULL CHECK (final_decision IN ('allow', 'review', 'deny')),
        allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)), needs_human_review INTEGER NOT NULL CHECK (needs_human_review IN (0, 1)),
        policy_hash TEXT, context_hash TEXT, safety_profile_hash TEXT, runtime_hash TEXT,
        model_version TEXT, evaluator_version TEXT, reason TEXT, summary TEXT, execution_status TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_log(request_id);
      CREATE INDEX IF NOT EXISTS idx_audit_project_time ON audit_log(project_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_fingerprint ON audit_log(fingerprint);
      UPDATE schema_meta SET value = '1' WHERE key = 'schema_version';
    `);
    if (row === undefined) db.prepare("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1')").run();
  }
}

export function openDatabase(path = process.env.JEV_CACHE_DB_PATH?.trim() || DEFAULT_DB_PATH): DatabaseSync {
  if (shared && sharedPath === path) return shared;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(path), 0o700); } catch { /* best effort */ }
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;');
    db.exec('BEGIN');
    try { migrate(db); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    shared = db; sharedPath = path;
    return db;
  } catch (error) { try { db.close(); } catch { /* best effort */ } throw error; }
}

export function resetDatabaseForTests(): void { if (shared) { shared.close(); shared = undefined; sharedPath = undefined; } }
