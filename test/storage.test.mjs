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
import { createOrGetEnvironmentReview, lookupEnvironmentApproval, revokeEnvironmentApproval, transitionEnvironmentApproval } from '../dist/storage/environment-approval.js';
import { consumeExecutionTicket, issueExecutionTicket } from '../dist/storage/execution-ticket.js';

const directories = [];
afterEach(() => { resetDatabaseForTests(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function databasePath() { const directory = mkdtempSync('/tmp/jev-storage-'); directories.push(directory); mkdirSync(join(directory, 'nested')); return join(directory, 'nested', 'jev.sqlite'); }
function key() { return { projectId: 'sha256:project', targetType: 'test-file', targetKey: 'tests/Test1.php', fingerprint: 'sha256:fingerprint', policyHash: 'sha256:policy', contextHash: 'sha256:context', safetyProfileHash: 'sha256:profile', runtimeHash: 'sha256:runtime', modelVersion: 'typesafe/jev', evaluatorVersion: 'jev-mcp-server@1.0.0' }; }

test('creates the cache directory, schema, and secure file permissions', () => {
  const path = databasePath(); const db = openDatabase(path);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name), ['audit_log', 'environment_approvals', 'execution_tickets', 'fingerprint_cache', 'human_reviews', 'schema_meta']);
  assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, '5');
});

test('environment approvals are exact, expiring, and revocable', () => {
  const db = openDatabase(databasePath());
  const key = { projectId: 'sha256:project', profileDigest: 'sha256:profile', environmentFingerprint: 'sha256:environment', scopeJson: '{"runner":"safe"}', verifierVersion: 'jev-mcp-server@1.1.0' };
  const pending = createOrGetEnvironmentReview(db, key, '2026-09-28T00:00:00.000Z', '2026-09-28T01:00:00.000Z');
  assert.equal(pending.status, 'pending');
  const approved = transitionEnvironmentApproval(db, pending.approvalId, 'approve', '2026-09-28T00:10:00.000Z', '2026-10-28T00:10:00.000Z');
  assert.equal(approved.status, 'approved');
  assert.ok(lookupEnvironmentApproval(db, key, '2026-09-28T00:20:00.000Z', approved.approvalId));
  assert.equal(lookupEnvironmentApproval(db, { ...key, environmentFingerprint: 'sha256:changed' }, '2026-09-28T00:20:00.000Z'), undefined);
  assert.equal(revokeEnvironmentApproval(db, approved.approvalId, '2026-09-28T00:30:00.000Z').status, 'revoked');
  assert.equal(lookupEnvironmentApproval(db, key, '2026-09-28T00:40:00.000Z'), undefined);
});

test('execution tickets are exact and single-use', () => {
  const db = openDatabase(databasePath());
  const environmentKey = { projectId: 'sha256:project', profileDigest: 'sha256:profile', environmentFingerprint: 'sha256:environment', scopeJson: '{}', verifierVersion: 'jev-mcp-server@1.1.0' };
  const pending = createOrGetEnvironmentReview(db, environmentKey, '2026-09-28T00:00:00.000Z', '2026-09-28T01:00:00.000Z');
  transitionEnvironmentApproval(db, pending.approvalId, 'approve', '2026-09-28T00:00:30.000Z', '2026-10-28T00:00:30.000Z');
  const key = { approvalId: pending.approvalId, projectId: 'sha256:project', environmentFingerprint: 'sha256:environment', codeFingerprint: 'sha256:code', executionFingerprint: 'sha256:execution' };
  const ticket = issueExecutionTicket(db, key, '2026-09-28T00:00:00.000Z', '2026-09-28T00:05:00.000Z');
  assert.equal(consumeExecutionTicket(db, ticket.token, { ...key, executionFingerprint: 'sha256:changed' }, '2026-09-28T00:01:00.000Z'), false);
  assert.equal(consumeExecutionTicket(db, ticket.token, key, '2026-09-28T00:01:00.000Z'), true);
  assert.equal(consumeExecutionTicket(db, ticket.token, key, '2026-09-28T00:02:00.000Z'), false);
});

test('revoking an environment approval invalidates outstanding execution tickets', () => {
  const db = openDatabase(databasePath());
  const environmentKey = { projectId: 'sha256:project', profileDigest: 'sha256:profile', environmentFingerprint: 'sha256:environment', scopeJson: '{}', verifierVersion: 'jev-mcp-server@1.1.0' };
  const pending = createOrGetEnvironmentReview(db, environmentKey, '2026-09-28T00:00:00.000Z', '2026-09-28T01:00:00.000Z');
  transitionEnvironmentApproval(db, pending.approvalId, 'approve', '2026-09-28T00:00:30.000Z', '2026-10-28T00:00:30.000Z');
  const key = { approvalId: pending.approvalId, projectId: 'sha256:project', environmentFingerprint: 'sha256:environment', codeFingerprint: 'sha256:code', executionFingerprint: 'sha256:execution' };
  const ticket = issueExecutionTicket(db, key, '2026-09-28T00:01:00.000Z', '2026-09-28T00:06:00.000Z');
  revokeEnvironmentApproval(db, pending.approvalId, '2026-09-28T00:02:00.000Z');
  assert.equal(consumeExecutionTicket(db, ticket.token, key, '2026-09-28T00:03:00.000Z'), false);
});

test('stores and looks up reusable allow entries, but not review or deny', () => {
  const db = openDatabase(databasePath()); const now = new Date().toISOString(); const cacheKey = key();
  upsertCache(db, cacheKey, 'allow', true, now);
  assert.equal(lookupAllow(db, cacheKey)?.decision, 'allow');
  assert.equal(lookupAllow(db, { ...cacheKey, modelVersion: 'cloudflare:typesafe/jev' }), undefined);
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
