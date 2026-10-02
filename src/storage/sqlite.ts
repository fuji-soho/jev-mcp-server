import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DB_PATH = join(PROJECT_ROOT, 'cache', 'jev.sqlite');
export const CURRENT_SCHEMA_VERSION = 7;

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
  if (version <= 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS human_reviews (
        id INTEGER PRIMARY KEY,
        review_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        test_files_hash TEXT NOT NULL,
        cwd_hash TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        context_hash TEXT NOT NULL,
        safety_profile_hash TEXT,
        runtime_hash TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision = 'review'),
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        approval_kind TEXT CHECK (approval_kind IS NULL OR approval_kind IN ('approve_fingerprint', 'approve_once')),
        created_at TEXT NOT NULL,
        approved_at TEXT,
        rejected_at TEXT,
        expires_at TEXT,
        used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_human_reviews_lookup ON human_reviews(project_id, target_type, target_key, fingerprint, policy_hash, context_hash, runtime_hash);
      CREATE INDEX IF NOT EXISTS idx_human_reviews_review_id ON human_reviews(review_id);
      CREATE INDEX IF NOT EXISTS idx_human_reviews_audit ON human_reviews(status, created_at);
      UPDATE schema_meta SET value = '2' WHERE key = 'schema_version';
    `);
  }
  if (version <= 2) {
    db.exec(`
      ALTER TABLE human_reviews RENAME TO human_reviews_legacy;
      CREATE TABLE human_reviews (
        id INTEGER PRIMARY KEY,
        review_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        test_files_hash TEXT NOT NULL,
        cwd_hash TEXT NOT NULL,
        policy_hash TEXT NOT NULL,
        context_hash TEXT NOT NULL,
        safety_profile_hash TEXT,
        runtime_hash TEXT NOT NULL,
        decision TEXT NOT NULL CHECK (decision = 'review'),
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
        approval_kind TEXT CHECK (approval_kind IS NULL OR approval_kind IN ('approve_fingerprint', 'approve_once')),
        created_at TEXT NOT NULL,
        approved_at TEXT,
        rejected_at TEXT,
        expires_at TEXT,
        used_at TEXT
      );
      INSERT INTO human_reviews(id,review_id,project_id,target_type,target_key,fingerprint,command_hash,test_files_hash,cwd_hash,policy_hash,context_hash,safety_profile_hash,runtime_hash,decision,status,approval_kind,created_at,approved_at,rejected_at,expires_at,used_at)
        SELECT id,review_id,project_id,target_type,target_key,fingerprint,command_hash,test_files_hash,cwd_hash,policy_hash,context_hash,safety_profile_hash,runtime_hash,decision,status,approval_kind,created_at,approved_at,rejected_at,expires_at,used_at FROM human_reviews_legacy;
      DROP TABLE human_reviews_legacy;
      CREATE UNIQUE INDEX idx_human_reviews_active ON human_reviews(project_id,target_type,target_key,fingerprint,policy_hash,context_hash,runtime_hash) WHERE status IN ('pending', 'approved');
      CREATE INDEX IF NOT EXISTS idx_human_reviews_lookup ON human_reviews(project_id, target_type, target_key, fingerprint, policy_hash, context_hash, runtime_hash);
      CREATE INDEX IF NOT EXISTS idx_human_reviews_review_id ON human_reviews(review_id);
      CREATE INDEX IF NOT EXISTS idx_human_reviews_audit ON human_reviews(status, created_at);
      UPDATE schema_meta SET value = '3' WHERE key = 'schema_version';
    `);
  }
  if (version <= 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS environment_approvals (
        id INTEGER PRIMARY KEY,
        approval_id TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        profile_digest TEXT NOT NULL,
        environment_fingerprint TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        verifier_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','revoked','expired')),
        created_at TEXT NOT NULL,
        approved_at TEXT,
        rejected_at TEXT,
        revoked_at TEXT,
        expires_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_approvals_active
        ON environment_approvals(project_id, environment_fingerprint)
        WHERE status IN ('pending','approved');
      CREATE INDEX IF NOT EXISTS idx_environment_approvals_lookup
        ON environment_approvals(project_id, environment_fingerprint, status, expires_at);

      CREATE TABLE IF NOT EXISTS execution_tickets (
        id INTEGER PRIMARY KEY,
        ticket_hash TEXT NOT NULL UNIQUE,
        approval_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        environment_fingerprint TEXT NOT NULL,
        code_fingerprint TEXT NOT NULL,
        execution_fingerprint TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_execution_tickets_expiry ON execution_tickets(expires_at);
      UPDATE schema_meta SET value = '4' WHERE key = 'schema_version';
    `);
  }
  if (version <= 4) {
    db.exec(`
      ALTER TABLE fingerprint_cache ADD COLUMN actual_model TEXT;
      ALTER TABLE audit_log ADD COLUMN jev_provider TEXT;
      ALTER TABLE audit_log ADD COLUMN requested_model TEXT;
      ALTER TABLE audit_log ADD COLUMN actual_model TEXT;
      UPDATE schema_meta SET value = '5' WHERE key = 'schema_version';
    `);
  }
  if (version <= 5) {
    // Legacy allow entries may have come from a time-limited Human Approval.
    // Their origin cannot be recovered reliably, so retain but disable all of them.
    db.exec(`
      ALTER TABLE human_reviews ADD COLUMN actual_model TEXT;
      UPDATE fingerprint_cache SET reusable = 0;
      UPDATE schema_meta SET value = '6' WHERE key = 'schema_version';
    `);
  }
  if (version <= 6) {
    db.exec(`
      CREATE TABLE test_execution_approvals (
        approval_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, profile_path TEXT NOT NULL,
        fingerprint TEXT NOT NULL, policy_hash TEXT NOT NULL, verifier_version TEXT NOT NULL,
        scope_json TEXT NOT NULL, request_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','revoked','expired','superseded')),
        created_at TEXT NOT NULL, approved_at TEXT, rejected_at TEXT, revoked_at TEXT, expires_at TEXT
      );
      CREATE UNIQUE INDEX idx_test_execution_active ON test_execution_approvals(project_id,profile_path)
        WHERE status IN ('pending','approved');
      UPDATE schema_meta SET value = '7' WHERE key = 'schema_version';
    `);
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
