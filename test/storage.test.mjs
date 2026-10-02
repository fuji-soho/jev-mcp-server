import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, afterEach } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, resetDatabaseForTests } from '../dist/storage/sqlite.js';
import { lookupAllow, upsertCache } from '../dist/storage/fingerprint-cache.js';
import { bindHumanReviewModel, createOrGetHumanReview, getHumanReview, lookupApprovedHumanReview, transitionHumanReview } from '../dist/storage/human-review.js';
import { insertAudit } from '../dist/storage/audit-log.js';
import { sanitizeAuditText } from '../dist/audit-sanitizer.js';
import { createOrGetEnvironmentReview, lookupEnvironmentApproval, revokeEnvironmentApproval, transitionEnvironmentApproval } from '../dist/storage/environment-approval.js';
import { consumeExecutionTicket, issueExecutionTicket } from '../dist/storage/execution-ticket.js';
import { buildFingerprint, EVALUATOR_VERSION, testInputIdentity } from '../dist/safety-fingerprint.js';

const directories = [];
afterEach(() => { resetDatabaseForTests(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function databasePath() { const directory = mkdtempSync('/tmp/jev-storage-'); directories.push(directory); mkdirSync(join(directory, 'nested')); return join(directory, 'nested', 'jev.sqlite'); }
function key() { return { projectId: 'sha256:project', targetType: 'test-file', targetKey: 'tests/Test1.php', fingerprint: 'sha256:fingerprint', policyHash: 'sha256:policy', contextHash: 'sha256:context', safetyProfileHash: 'sha256:profile', runtimeHash: 'sha256:runtime', modelVersion: 'typesafe/jev', evaluatorVersion: 'jev-mcp-server@1.0.0' }; }

function reviewKey() {
  return { projectId: 'sha256:project', targetType: 'test-file', targetKey: 'tests/Test1.php', fingerprint: 'sha256:code', commandHash: 'sha256:command', testFilesHash: 'sha256:files', cwdHash: 'sha256:cwd', policyHash: 'sha256:policy', contextHash: 'sha256:context', runtimeHash: 'sha256:runtime' };
}

for (const oldVersion of ['jev-mcp-server@1.1.0:approval-model-v1', 'jev-mcp-server@1.1.0:approval-model-v1:raw-test-input-v1']) {
test(`the current evaluator cannot reuse ${oldVersion} cache or model-bound approval records`, () => {
  const db = openDatabase(databasePath());
  assert.notEqual(EVALUATOR_VERSION, oldVersion);
  const common = key();
  const oldFingerprint = buildFingerprint({ ...common, evaluatorVersion: oldVersion, testSpecific: { command: 'npm test', testCode: 'const secret = [REDACTED]' } });
  const currentFingerprint = buildFingerprint({ ...common, evaluatorVersion: EVALUATOR_VERSION, testSpecific: testInputIdentity({ command: 'npm test', testCode: 'const secret = "fixture-b";' }) });
  const now = '2026-09-30T00:00:00.000Z';
  upsertCache(db, { ...common, fingerprint: oldFingerprint, evaluatorVersion: oldVersion }, 'allow', true, now, 'jev-1.13.0');
  assert.equal(lookupAllow(db, { ...common, fingerprint: currentFingerprint, evaluatorVersion: EVALUATOR_VERSION }), undefined);
  const approvedKey = bindHumanReviewModel({ ...reviewKey(), fingerprint: oldFingerprint }, 'jev-1.13.0');
  const pending = createOrGetHumanReview(db, approvedKey, now, '2026-09-30T01:00:00.000Z');
  transitionHumanReview(db, pending.reviewId, 'approve', now);
  assert.equal(lookupApprovedHumanReview(db, bindHumanReviewModel({ ...reviewKey(), fingerprint: currentFingerprint }, 'jev-1.13.0'), now), undefined);
  assert.equal(getHumanReview(db, pending.reviewId).status, 'approved', 'history remains available');
  assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, '6');
});
}

test('approval fingerprints bind actual model and every supplied safety context', () => {
  const base = reviewKey();
  const bound = bindHumanReviewModel(base, 'jev-1.13.0');
  assert.notEqual(bound.fingerprint, base.fingerprint);
  assert.deepEqual(bindHumanReviewModel(base, 'jev-1.13.0'), bound);
  assert.notEqual(bindHumanReviewModel(base, 'jev-1.14.0').fingerprint, bound.fingerprint);
  for (const field of Object.keys(base)) {
    assert.notEqual(bindHumanReviewModel({ ...base, [field]: `${base[field]}-changed` }, 'jev-1.13.0').fingerprint, bound.fingerprint, field);
  }
});

for (const status of ['pending', 'approved']) {
  test(`expired ${status} review is replaced at its deadline`, () => {
    const db = openDatabase(databasePath());
    const bound = bindHumanReviewModel(reviewKey(), 'jev-1.13.0');
    const deadline = '2026-09-30T01:00:00.000Z';
    const first = createOrGetHumanReview(db, bound, '2026-09-30T00:00:00.000Z', deadline);
    if (status === 'approved') transitionHumanReview(db, first.reviewId, 'approve', '2026-09-30T00:10:00.000Z');
    assert.equal(createOrGetHumanReview(db, bound, '2026-09-30T00:59:59.999Z', deadline).reviewId, first.reviewId);
    assert.equal(lookupApprovedHumanReview(db, bound, deadline), undefined);
    const replacement = createOrGetHumanReview(db, bound, deadline, '2026-09-30T02:00:00.000Z');
    assert.notEqual(replacement.reviewId, first.reviewId);
    assert.equal(replacement.status, 'pending');
    assert.equal(getHumanReview(db, first.reviewId).status, 'expired');
  });
}

function legacyDatabase() {
  const path = databasePath();
  const db = openDatabase(path);
  const now = '2026-09-30T00:00:00.000Z';
  upsertCache(db, key(), 'allow', true, now, 'jev-1.13.0');
  const review = createOrGetHumanReview(db, { ...reviewKey(), actualModel: 'jev-1.13.0' }, now, '2026-09-30T01:00:00.000Z');
  transitionHumanReview(db, review.reviewId, 'approve', now);
  const environmentKey = { projectId: 'sha256:project', profileDigest: 'sha256:profile', environmentFingerprint: 'sha256:environment', scopeJson: '{}', verifierVersion: 'jev-environment-profile-v2@1' };
  const environment = createOrGetEnvironmentReview(db, environmentKey, now, '2026-09-30T01:00:00.000Z');
  transitionEnvironmentApproval(db, environment.approvalId, 'approve', now, '2026-10-30T00:00:00.000Z');
  insertAudit(db, { requestId: 'legacy', toolName: 'jev_check_test', cacheStatus: 'miss', finalDecision: 'allow', allowed: true, needsHumanReview: false });
  // Schema 5 has the same tables and indexes, without human_reviews.actual_model.
  db.exec("ALTER TABLE human_reviews DROP COLUMN actual_model; UPDATE schema_meta SET value='5' WHERE key='schema_version';");
  resetDatabaseForTests();
  return { path, review, environmentKey, environment, now };
}

test('schema 5 migration disables old allow without deleting approval or audit history', () => {
  const { path, review, environmentKey, environment, now } = legacyDatabase();
  const db = openDatabase(path);
  assert.equal(lookupAllow(db, key()), undefined);
  assert.equal(db.prepare('SELECT reusable FROM fingerprint_cache').get().reusable, 0);
  assert.equal(getHumanReview(db, review.reviewId).status, 'approved');
  assert.equal(getHumanReview(db, review.reviewId).actualModel, undefined);
  assert.equal(lookupApprovedHumanReview(db, bindHumanReviewModel(reviewKey(), 'jev-1.13.0'), now), undefined);
  assert.equal(lookupEnvironmentApproval(db, environmentKey, now).approvalId, environment.approvalId);
  assert.equal(db.prepare('SELECT request_id FROM audit_log').get().request_id, 'legacy');
  upsertCache(db, key(), 'allow', true, now, 'jev-1.13.0');
  resetDatabaseForTests();
  assert.ok(lookupAllow(openDatabase(path), key()), 'migration must not invalidate new entries on every startup');
});

test('a failed migration rolls back schema and cache changes', () => {
  const { path } = legacyDatabase();
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TRIGGER migration_failure BEFORE UPDATE ON fingerprint_cache BEGIN SELECT RAISE(ABORT, 'mock migration failure'); END;");
  raw.close();
  assert.throws(() => openDatabase(path), /mock migration failure/u);
  const restored = new DatabaseSync(path);
  try {
    assert.equal(restored.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, '5');
    assert.equal(restored.prepare('SELECT reusable FROM fingerprint_cache').get().reusable, 1);
    assert.equal(restored.prepare('PRAGMA table_info(human_reviews)').all().some((column) => column.name === 'actual_model'), false);
  } finally { restored.close(); }
});

test('creates the cache directory, schema, and secure file permissions', () => {
  const path = databasePath(); const db = openDatabase(path);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name), ['audit_log', 'environment_approvals', 'execution_tickets', 'fingerprint_cache', 'human_reviews', 'schema_meta']);
  assert.equal(db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value, '6');
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
  assert.equal(consumeExecutionTicket(db, ticket.token, key, '2026-09-28T00:01:00.000Z'), false, 'an identity mismatch permanently revokes the ticket');
  const valid = issueExecutionTicket(db, key, '2026-09-28T00:00:00.000Z', '2026-09-28T00:05:00.000Z');
  assert.equal(consumeExecutionTicket(db, valid.token, key, '2026-09-28T00:01:00.000Z'), true);
  assert.equal(consumeExecutionTicket(db, valid.token, key, '2026-09-28T00:02:00.000Z'), false);
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
    actualModel: 'jev-1.13.0',
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
