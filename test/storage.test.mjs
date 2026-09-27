import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, afterEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, resetDatabaseForTests } from '../dist/storage/sqlite.js';
import { lookupAllow, upsertCache } from '../dist/storage/fingerprint-cache.js';
import { createOrGetHumanReview, getHumanReview, lookupApprovedHumanReview, transitionHumanReview } from '../dist/storage/human-review.js';
import { insertAudit } from '../dist/storage/audit-log.js';
import { sanitizeAuditText } from '../dist/audit-sanitizer.js';

const directories = [];
afterEach(() => { resetDatabaseForTests(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function databasePath() { const directory = mkdtempSync('/tmp/jev-storage-'); directories.push(directory); mkdirSync(join(directory, 'nested')); return join(directory, 'nested', 'jev.sqlite'); }
function key() { return { projectId: 'sha256:project', targetType: 'test-file', targetKey: 'tests/Test1.php', fingerprint: 'sha256:fingerprint', policyHash: 'sha256:policy', contextHash: 'sha256:context', safetyProfileHash: 'sha256:profile', runtimeHash: 'sha256:runtime', modelVersion: 'typesafe/jev', evaluatorVersion: 'jev-mcp-server@1.0.0' }; }

test('creates the cache directory, schema, and secure file permissions', () => {
  const path = databasePath(); const db = openDatabase(path);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name), ['audit_log', 'fingerprint_cache', 'human_reviews', 'schema_meta']);
  assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, '3');
});

test('stores and looks up reusable allow entries, but not review or deny', () => {
  const db = openDatabase(databasePath()); const now = new Date().toISOString(); const cacheKey = key();
  upsertCache(db, cacheKey, 'allow', true, now);
  assert.equal(lookupAllow(db, cacheKey)?.decision, 'allow');
  upsertCache(db, { ...cacheKey, fingerprint: 'sha256:review' }, 'review', false, now);
  assert.equal(lookupAllow(db, { ...cacheKey, fingerprint: 'sha256:review' }), undefined);
});

test('stores an audit row for a cache hit without a Jev decision', () => {
  const db = openDatabase(databasePath());
  insertAudit(db, { requestId: 'request-1', projectId: 'sha256:project', toolName: 'jev_check_test', targetType: 'test-file', targetKey: 'tests/Test1.php', fingerprint: 'sha256:fingerprint', cacheStatus: 'hit', finalDecision: 'allow', allowed: true, needsHumanReview: false, jevDecision: undefined, reason: 'unchanged token=secret' });
  const row = db.prepare('SELECT cache_status, jev_decision, final_decision, reason FROM audit_log').get();
  assert.equal(row.cache_status, 'hit'); assert.equal(row.jev_decision, null); assert.equal(row.final_decision, 'allow'); assert.match(row.reason, /token=\[REDACTED\]/u);
});

test('redacts credentials and does not preserve private key material', () => {
  const value = sanitizeAuditText('Authorization: Bearer abc API_TOKEN=secret --password hunter2 -----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----');
  assert.equal(value.includes('abc'), false); assert.equal(value.includes('secret'), false); assert.equal(value.includes('hunter2'), false); assert.equal(value.includes('BEGIN PRIVATE KEY'), false);
});

test('rejects a newer schema without deleting the database', () => {
  const path = databasePath(); const raw = new DatabaseSync(path); raw.exec("CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO schema_meta VALUES ('schema_version', '99');"); raw.close();
  assert.throws(() => openDatabase(path), /Unsupported SQLite schema version/u);
});

test('does not recreate a corrupt database automatically', () => {
  const path = databasePath(); writeFileSync(path, 'not sqlite', 'utf8');
  assert.throws(() => openDatabase(path));
});

test('stores, approves, rejects, and matches Human Reviews by every safety key', () => {
  const db = openDatabase(databasePath());
  const key = {
    projectId: 'sha256:project', targetType: 'test-file', targetKey: 'tests/Test1.php', fingerprint: 'sha256:fingerprint',
    commandHash: 'sha256:command', testFilesHash: 'sha256:files', cwdHash: 'sha256:cwd', policyHash: 'sha256:policy',
    contextHash: 'sha256:context', safetyProfileHash: 'sha256:profile', runtimeHash: 'sha256:runtime',
  };
  const created = createOrGetHumanReview(db, key, '2026-09-27T00:00:00.000Z', '2026-09-27T01:00:00.000Z');
  assert.match(created.reviewId, /^rev_/u);
  assert.equal(created.status, 'pending');
  const approved = transitionHumanReview(db, created.reviewId, 'approve', '2026-09-27T00:10:00.000Z');
  assert.equal(approved.status, 'approved');
  assert.ok(lookupApprovedHumanReview(db, key, '2026-09-27T00:20:00.000Z'));
  assert.equal(lookupApprovedHumanReview(db, { ...key, commandHash: 'sha256:changed' }, '2026-09-27T00:20:00.000Z'), undefined);
  assert.throws(() => transitionHumanReview(db, created.reviewId, 'reject', '2026-09-27T00:20:00.000Z'), /not pending/u);

  const rejected = createOrGetHumanReview(db, { ...key, targetKey: 'tests/Test2.php', fingerprint: 'sha256:other' }, '2026-09-27T00:00:00.000Z');
  assert.equal(transitionHumanReview(db, rejected.reviewId, 'reject', '2026-09-27T00:10:00.000Z').status, 'rejected');
  assert.throws(() => transitionHumanReview(db, rejected.reviewId, 'approve', '2026-09-27T00:20:00.000Z'), /not pending/u);
  const replacement = createOrGetHumanReview(db, { ...key, targetKey: 'tests/Test2.php', fingerprint: 'sha256:other' }, '2026-09-27T00:30:00.000Z');
  assert.notEqual(replacement.reviewId, rejected.reviewId);
  assert.equal(replacement.status, 'pending');
  assert.equal(getHumanReview(db, 'rev_missing'), undefined);
  assert.throws(() => transitionHumanReview(db, 'rev_missing', 'approve', '2026-09-27T00:20:00.000Z'), /Unknown review_id/u);
  assert.equal(lookupApprovedHumanReview(db, { ...key, projectId: 'sha256:other-project' }, '2026-09-27T00:20:00.000Z'), undefined);
});
