import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, afterEach } from 'node:test';
import { evaluateTest } from '../dist/test-checker.js';
import { assessSafetyProfile, verifySafetyProfile } from '../dist/test-safety-profile.js';
import { openDatabase } from '../dist/storage/sqlite.js';
import { getHumanReview, transitionHumanReview } from '../dist/storage/human-review.js';
import { transitionEnvironmentApproval } from '../dist/storage/environment-approval.js';
import { consumeExecutionTicket } from '../dist/storage/execution-ticket.js';

const config = {
  provider: 'cloudflare',
  accountId: 'test-account',
  apiToken: 'test-token',
  requestedModel: 'typesafe/jev',
};

const pinnedConfig = { provider: 'typesafe', apiKey: 'test-token', requestedModel: 'jev-1.13.0' };

function modelResponse(provider, dangerous = 0.1, model = 'jev-1.13.0') {
  const output = { model, answers: { test_dangerous: { type: 'noul', noul: dangerous } }, usage: { input_tokens: 1, output_tokens: 1 } };
  return new Response(JSON.stringify(provider === 'cloudflare' ? { success: true, result: { state: 'Completed', result: output } } : output), { status: 200 });
}

function isolatedInput(cwd) {
  return { command: 'node --test tests/check.js', cwd, environment: 'testing', isolation: { temporaryFilesystem: true, mockedExternalServices: true }, runtime: { productionAccess: false, persistentStorageAccess: false, networkAccess: false } };
}

function temporaryTestProject(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'jev-raw-input-'));
  mkdirSync(join(cwd, 'tests'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test('masked-only file changes miss cache without exposing raw values', async (t) => {
  const cwd = temporaryTestProject(t);
  const logPath = join(cwd, 'jev.log');
  const priorLogPath = process.env.JEV_LOG_PATH;
  process.env.JEV_LOG_PATH = logPath;
  t.after(() => { if (priorLogPath === undefined) delete process.env.JEV_LOG_PATH; else process.env.JEV_LOG_PATH = priorLogPath; });
  const file = join(cwd, 'tests', 'check.js');
  const secrets = ['raw-fixture-alpha-7283', 'raw-fixture-beta-9641'];
  const input = { ...isolatedInput(cwd), testFiles: ['tests/check.js'] };
  const bodies = [];
  globalThis.fetch = async (_url, init) => { bodies.push(init.body); return modelResponse('typesafe'); };
  writeFileSync(file, `const secret = "${secrets[0]}";\n`);
  const first = await evaluateTest(pinnedConfig, input);
  assert.equal(first.decision, 'allow');
  const unchanged = await evaluateTest(pinnedConfig, input);
  assert.equal(unchanged.codeAssessment.status, 'cache-hit');
  assert.equal(bodies.length, 1);
  writeFileSync(file, `const secret = "${secrets[1]}";\n`);
  const changed = await evaluateTest(pinnedConfig, input);
  assert.equal(changed.decision, 'allow');
  assert.equal(changed.codeAssessment.status, 'evaluated');
  assert.notEqual(changed.codeAssessment.fingerprint, first.codeAssessment.fingerprint);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1], 'outbound masked code remains identical');
  const db = openDatabase();
  const persisted = ['fingerprint_cache', 'human_reviews', 'audit_log', 'execution_tickets'].map((table) => JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())).join('\n');
  const outputs = JSON.stringify([first, unchanged, changed]);
  for (const secret of secrets) {
    assert.equal(bodies.join('\n').includes(secret), false);
    assert.equal(persisted.includes(secret), false);
    assert.equal(outputs.includes(secret), false);
    assert.equal(readFileSync(logPath, 'utf8').includes(secret), false);
  }
});

for (const field of ['testCode', 'diff', 'context', 'command']) {
  test(`masked-only inline ${field} changes invalidate cache and Human Approval`, async (t) => {
    const cwd = temporaryTestProject(t);
    const base = isolatedInput(cwd);
    const value = (suffix) => field === 'command' ? `node --test --token inline-fixture-${suffix}` : `const secret = "inline-fixture-${suffix}";`;
    const firstInput = { ...base, [field]: value('a') };
    const secondInput = { ...base, [field]: value('b') };
    let calls = 0;
    let dangerous = 0.1;
    const bodies = [];
    globalThis.fetch = async (_url, init) => { calls += 1; bodies.push(init.body); return modelResponse('typesafe', dangerous); };
    const first = await evaluateTest(pinnedConfig, firstInput);
    assert.equal(first.decision, 'allow');
    assert.equal((await evaluateTest(pinnedConfig, firstInput)).codeAssessment.status, 'cache-hit');
    const changed = await evaluateTest(pinnedConfig, secondInput);
    assert.equal(changed.codeAssessment.status, 'evaluated');
    assert.notEqual(changed.codeAssessment.fingerprint, first.codeAssessment.fingerprint);
    assert.equal(calls, 2);
    assert.equal(bodies[0], bodies[1]);
    // A separate target avoids an automatic allow entry masking the approval test.
    const reviewA = { ...firstInput, framework: 'vitest' };
    const reviewB = { ...secondInput, framework: 'vitest' };
    dangerous = 0.5;
    const pending = await evaluateTest(pinnedConfig, reviewA);
    assert.equal(pending.decision, 'review');
    transitionHumanReview(openDatabase(), pending.reviewId, 'approve', new Date().toISOString());
    assert.equal((await evaluateTest(pinnedConfig, reviewA)).decision, 'allow');
    const changedReview = await evaluateTest(pinnedConfig, reviewB);
    assert.equal(changedReview.decision, 'review');
    assert.equal(changedReview.allowed, false);
    assert.notEqual(changedReview.reviewId, pending.reviewId);
    assert.equal(calls, 5);
  });
}

test('file identity uses original bytes even when UTF-8 decoding produces identical code', async (t) => {
  const cwd = temporaryTestProject(t);
  const file = join(cwd, 'tests', 'check.js');
  const input = { ...isolatedInput(cwd), testFiles: ['tests/check.js'] };
  let calls = 0;
  const bodies = [];
  globalThis.fetch = async (_url, init) => { calls += 1; bodies.push(init.body); return modelResponse('typesafe'); };
  writeFileSync(file, Buffer.from([0x2f, 0x2f, 0xff]));
  const first = await evaluateTest(pinnedConfig, input);
  writeFileSync(file, Buffer.from([0x2f, 0x2f, 0xfe]));
  const second = await evaluateTest(pinnedConfig, input);
  assert.equal(first.decision, 'allow');
  assert.equal(second.codeAssessment.status, 'evaluated');
  assert.notEqual(first.codeAssessment.fingerprint, second.codeAssessment.fingerprint);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(calls, 2);
});

test('only the file with a masked-only change is re-evaluated in a multi-file check', async (t) => {
  const cwd = temporaryTestProject(t);
  const files = ['tests/check.js', 'tests/other.js'];
  for (const file of files) writeFileSync(join(cwd, file), 'const secret = "multi-fixture-a";\n');
  const input = { ...isolatedInput(cwd), testFiles: files };
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return modelResponse('typesafe'); };
  await evaluateTest(pinnedConfig, input);
  assert.equal(calls, 2);
  writeFileSync(join(cwd, files[0]), 'const secret = "multi-fixture-b";\n');
  assert.equal((await evaluateTest(pinnedConfig, input)).decision, 'allow');
  assert.equal(calls, 3);
});

test('a masked-only file change cannot reuse Human Approval', async (t) => {
  const cwd = temporaryTestProject(t);
  const file = join(cwd, 'tests', 'check.js');
  const input = { ...isolatedInput(cwd), testFiles: ['tests/check.js'] };
  globalThis.fetch = async () => modelResponse('typesafe', 0.5);
  writeFileSync(file, 'const secret = "approval-fixture-a";\n');
  const pending = await evaluateTest(pinnedConfig, input);
  transitionHumanReview(openDatabase(), pending.reviewId, 'approve', new Date().toISOString());
  assert.equal((await evaluateTest(pinnedConfig, input)).decision, 'allow');
  writeFileSync(file, 'const secret = "approval-fixture-b";\n');
  const changed = await evaluateTest(pinnedConfig, input);
  assert.equal(changed.decision, 'review');
  assert.equal(changed.allowed, false);
  assert.notEqual(changed.reviewId, pending.reviewId);
  assert.notEqual(changed.codeAssessment.fingerprint, pending.codeAssessment.fingerprint);
});

test('Profile v2 detects masked file changes while preserving environment approval and selector cache reuse', async (t) => {
  const cwd = profileV2Project();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const file = join(cwd, 'tests', 'Feature', 'RawTest.php');
  const input = profileV2Input(cwd, 'tests/Feature/RawTest.php');
  writeFileSync(file, '<?php $secret = "v2-fixture-a";\n');
  let dangerous = 0.1;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return modelResponse('typesafe', dangerous); };
  const pending = await evaluateTest(pinnedConfig, input);
  const now = new Date();
  transitionEnvironmentApproval(openDatabase(), pending.environmentReviewId, 'approve', now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
  const first = await evaluateTest(pinnedConfig, input);
  assert.equal(first.decision, 'allow');
  const filtered = await evaluateTest(pinnedConfig, profileV2Input(cwd, 'tests/Feature/RawTest.php', 'RawTest::testIt'));
  assert.equal(filtered.codeAssessment.status, 'cache-hit');
  assert.equal(calls, 1);
  writeFileSync(file, '<?php $secret = "v2-fixture-b";\n');
  dangerous = 0.5;
  const codePending = await evaluateTest(pinnedConfig, input);
  assert.equal(codePending.decision, 'review');
  assert.equal(codePending.environmentAssessment.approvalId, first.environmentAssessment.approvalId);
  transitionHumanReview(openDatabase(), codePending.reviewId, 'approve', now.toISOString());
  const approved = await evaluateTest(pinnedConfig, input);
  assert.equal(approved.decision, 'allow');
  assert.notEqual(approved.codeAssessment.fingerprint, first.codeAssessment.fingerprint);
  const currentKey = { approvalId: approved.environmentAssessment.approvalId, projectId: getHumanReview(openDatabase(), codePending.reviewId).projectId, environmentFingerprint: approved.environmentAssessment.environmentFingerprint, codeFingerprint: approved.codeAssessment.fingerprint, executionFingerprint: approved.executionAssessment.executionFingerprint };
  assert.equal(consumeExecutionTicket(openDatabase(), first.executionAssessment.ticket, currentKey, now.toISOString()), false);
  writeFileSync(file, '<?php $secret = "v2-fixture-c";\n');
  const changed = await evaluateTest(pinnedConfig, input);
  assert.equal(changed.decision, 'review');
  assert.notEqual(changed.reviewId, codePending.reviewId);
  assert.equal(changed.environmentAssessment.approvalId, first.environmentAssessment.approvalId);
  assert.equal(changed.environmentReviewId, undefined);
  assert.equal(changed.executionAssessment.ticket, undefined);
  assert.equal(calls, 4);
});

const lowRiskResponse = () => new Response(JSON.stringify({
  success: true,
  result: {
    state: 'Completed',
    result: {
      model: 'jev-1.13.0',
      answers: {
        test_dangerous: { type: 'noul', noul: 0.1 },
      },
    },
  },
}), { status: 200, headers: { 'content-type': 'application/json' } });

const safeContext = [
  'APP_ENV=testing',
  'DB_CONNECTION=sqlite',
  'DB_DATABASE=:memory:',
  'configuration cache: disabled',
].join('\n');

const safeRuntimeEvidence = {
  runtimeDatabase: {
    connection: 'sqlite',
    database: ':memory:',
    enforced: true,
  },
  configCache: {
    clearedBeforeTest: true,
    restoredAfterTest: true,
  },
  runtimeGuard: {
    enabled: true,
    checksActualConnection: true,
    rejectsPersistentDatabase: true,
    rejectsFallback: true,
  },
  persistentDatabaseAccess: false,
};

afterEach(() => {
  delete globalThis.fetch;
  delete process.env.JEV_TEST_SAFETY_STATE_PATH;
});

function profileProject() {
  const cwd = mkdtempSync('/tmp/jev-safety-');
  mkdirSync(join(cwd, '.jev'));
  writeFileSync(join(cwd, 'package.json'), '{"private":true}\n');
  writeFileSync(join(cwd, '.jev', 'test-safety.json'), JSON.stringify({
    version: 1,
    name: 'vitest-isolated',
    framework: 'vitest',
    runner: { commands: ['npm test'], files: ['package.json'] },
    safetyFiles: ['package.json'],
    expected: {
      environment: 'testing',
      isolation: { temporaryFilesystem: true, mockedExternalServices: true },
      runtime: { productionAccess: false, persistentStorageAccess: false, networkAccess: false },
    },
  }));
  return cwd;
}

test('approval-derived allow never enters the cache and expires at the exact deadline', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 8, 30) });
  const cwd = profileProject();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  process.env.JEV_TEST_SAFETY_STATE_PATH = join(cwd, 'state.json');
  const input = profileInput(cwd);
  verifySafetyProfile(input);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return modelResponse('typesafe', 0.5); };
  const pending = await evaluateTest(pinnedConfig, input);
  assert.equal(pending.decision, 'review');
  transitionHumanReview(openDatabase(), pending.reviewId, 'approve', new Date().toISOString());
  const review = getHumanReview(openDatabase(), pending.reviewId);
  assert.equal(review.actualModel, 'jev-1.13.0');
  const expiry = Date.parse(review.expiresAt);
  t.mock.timers.setTime(expiry - 1);
  const approved = await evaluateTest(pinnedConfig, input);
  assert.equal(approved.decision, 'allow');
  assert.equal(approved.codeAssessment.status, 'evaluated');
  assert.equal(openDatabase().prepare('SELECT count(*) AS count FROM fingerprint_cache WHERE project_id=?').get(review.projectId).count, 0);
  assert.equal(openDatabase().prepare("SELECT final_decision FROM audit_log WHERE project_id=? ORDER BY id DESC LIMIT 1").get(review.projectId).final_decision, 'allow');
  t.mock.timers.setTime(expiry);
  const expired = await evaluateTest(pinnedConfig, input);
  assert.equal(expired.decision, 'review');
  assert.equal(expired.allowed, false);
  assert.notEqual(expired.reviewId, pending.reviewId);
  assert.equal(getHumanReview(openDatabase(), pending.reviewId).status, 'expired');
  t.mock.timers.setTime(expiry + 1);
  assert.equal((await evaluateTest(pinnedConfig, input)).decision, 'review');
  assert.equal(calls, 4);
});

test('an unchanged approved input still evaluates later Jev deny and API failure', async (t) => {
  const cwd = profileProject();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  process.env.JEV_TEST_SAFETY_STATE_PATH = join(cwd, 'state.json');
  const input = profileInput(cwd);
  verifySafetyProfile(input);
  globalThis.fetch = async () => modelResponse('typesafe', 0.5);
  const pending = await evaluateTest(pinnedConfig, input);
  transitionHumanReview(openDatabase(), pending.reviewId, 'approve', new Date().toISOString());
  assert.equal((await evaluateTest(pinnedConfig, input)).decision, 'allow');
  globalThis.fetch = async () => modelResponse('typesafe', 0.9);
  const denied = await evaluateTest(pinnedConfig, input);
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.allowed, false);
  globalThis.fetch = async () => { throw new Error('mock network failure'); };
  const failed = await evaluateTest(pinnedConfig, input);
  assert.equal(failed.decision, 'review');
  assert.equal(failed.allowed, false);
  assert.equal(failed.errorCode, 'JEV_NETWORK_ERROR');
  assert.equal(failed.reviewId, undefined);
});

for (const selected of [config, { ...pinnedConfig, requestedModel: 'jev-latest' }, { ...pinnedConfig, requestedModel: 'jev-preview' }]) {
  test(`${selected.provider}:${selected.requestedModel} binds approval to actual model and never reuses allow cache`, async (t) => {
    const cwd = profileProject();
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    process.env.JEV_TEST_SAFETY_STATE_PATH = join(cwd, 'state.json');
    const input = profileInput(cwd);
    verifySafetyProfile(input);
    let calls = 0;
    let actualModel = 'jev-1.13.0';
    let dangerous = 0.5;
    globalThis.fetch = async () => { calls += 1; return modelResponse(selected.provider, dangerous, actualModel); };
    const pending = await evaluateTest(selected, input);
    transitionHumanReview(openDatabase(), pending.reviewId, 'approve', new Date().toISOString());
    assert.equal((await evaluateTest(selected, input)).decision, 'allow');
    actualModel = 'jev-1.14.0';
    const changed = await evaluateTest(selected, input);
    assert.equal(changed.decision, 'review');
    assert.notEqual(changed.reviewId, pending.reviewId);
    assert.equal(getHumanReview(openDatabase(), changed.reviewId).actualModel, actualModel);
    assert.equal(calls, 3);
    dangerous = 0.1;
    assert.equal((await evaluateTest(selected, input)).decision, 'allow');
    assert.equal((await evaluateTest(selected, input)).codeAssessment.status, 'evaluated');
    assert.equal(calls, 5);
    dangerous = 0.9;
    assert.equal((await evaluateTest(selected, input)).decision, 'deny');
  });
}

test('an opaque actual model cannot issue an approvable review, but deny still wins', async () => {
  globalThis.fetch = async () => modelResponse('cloudflare', 0.5, 'typesafe/jev');
  const result = await evaluateTest(config, { command: 'npm test -- opaque-model-case' });
  assert.equal(result.decision, 'review');
  assert.equal(result.allowed, false);
  assert.equal(result.errorCode, 'JEV_MODEL_ID_UNVERIFIED');
  assert.equal(result.reviewId, undefined);
  globalThis.fetch = async () => modelResponse('cloudflare', 0.9, 'typesafe/jev');
  assert.equal((await evaluateTest(config, { command: 'npm test -- opaque-model-case' })).decision, 'deny');
});

test('a mismatched fixed-model response cannot populate reusable cache', async (t) => {
  const cwd = profileProject();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  process.env.JEV_TEST_SAFETY_STATE_PATH = join(cwd, 'state.json');
  const input = profileInput(cwd);
  verifySafetyProfile(input);
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return modelResponse('typesafe', 0.1, 'jev-1.14.0'); };
  assert.equal((await evaluateTest(pinnedConfig, input)).decision, 'allow');
  assert.equal((await evaluateTest(pinnedConfig, input)).codeAssessment.status, 'evaluated');
  assert.equal(calls, 2);
});

function profileInput(cwd) {
  return {
    command: 'npm test', cwd, framework: 'vitest', environment: 'testing',
    isolation: { temporaryFilesystem: true, mockedExternalServices: true },
    runtime: { productionAccess: false, persistentStorageAccess: false, networkAccess: false },
  };
}

test('verified Safety Profile allows an unchanged isolated test', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const cwd = profileProject();
  const statePath = join(cwd, 'state.json');
  process.env.JEV_TEST_SAFETY_STATE_PATH = statePath;
  const input = profileInput(cwd);
  const verified = verifySafetyProfile(input);
  assert.equal(verified.status, 'verified');
  const result = await evaluateTest(config, input);
  assert.equal(result.decision, 'allow');
  assert.equal(result.safetyProfile?.status, 'verified');
  rmSync(cwd, { recursive: true, force: true });
});

test('changed Safety Profile files require review', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const cwd = profileProject();
  process.env.JEV_TEST_SAFETY_STATE_PATH = join(cwd, 'state.json');
  const input = profileInput(cwd);
  verifySafetyProfile(input);
  writeFileSync(join(cwd, 'package.json'), '{"private":false}\n');
  const result = await evaluateTest(config, input);
  assert.equal(result.decision, 'review');
  assert.equal(result.safetyProfile?.status, 'changed');
  rmSync(cwd, { recursive: true, force: true });
});

test('nested Safety Profile changes invalidate v1 verification', () => {
  const cwd = profileProject();
  process.env.JEV_TEST_SAFETY_STATE_PATH = join(cwd, 'state.json');
  const input = profileInput(cwd);
  verifySafetyProfile(input);
  const profilePath = join(cwd, '.jev', 'test-safety.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  profile.runner.commands = ['npm test --changed'];
  writeFileSync(profilePath, JSON.stringify(profile));
  assert.equal(assessSafetyProfile(input).assessment.status, 'changed');
  rmSync(cwd, { recursive: true, force: true });
});

test('v1 verification state cannot be reused across projects', () => {
  const first = profileProject();
  const second = profileProject();
  process.env.JEV_TEST_SAFETY_STATE_PATH = join(first, 'shared-state.json');
  verifySafetyProfile(profileInput(first));
  assert.equal(assessSafetyProfile(profileInput(second)).assessment.status, 'changed');
  rmSync(first, { recursive: true, force: true });
  rmSync(second, { recursive: true, force: true });
});

test('verified Safety Profile never overrides a destructive finding', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const cwd = profileProject();
  process.env.JEV_TEST_SAFETY_STATE_PATH = join(cwd, 'state.json');
  const input = profileInput(cwd);
  verifySafetyProfile(input);
  const result = await evaluateTest(config, { ...input, command: 'npm test && DROP DATABASE app' });
  assert.equal(result.decision, 'deny');
  assert.equal(result.allowed, false);
  rmSync(cwd, { recursive: true, force: true });
});

test('RefreshDatabase with MySQL/MariaDB is denied', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, {
    command: 'php artisan test',
    testCode: 'use Illuminate\\Foundation\\Testing\\RefreshDatabase; class ApplicationTest { use RefreshDatabase; }',
    context: 'APP_ENV=testing\nDB_CONNECTION=mysql\nDB_DATABASE=production_database',
  });

  assert.equal(result.allowed, false);
  assert.equal(result.decision, 'deny');
  assert.ok(result.staticFindings.includes('RefreshDatabase'));
  assert.ok(result.staticFindings.includes('persistent database target is not confirmed as test-only'));
});

test('DatabaseTruncation is denied', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, {
    command: 'php artisan test',
    testCode: 'use DatabaseTruncation;',
    context: safeContext,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.decision, 'deny');
  assert.deepEqual(result.staticFindings, ['DatabaseTruncation']);
});

test('migrate:fresh is denied', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, {
    command: 'php artisan migrate:fresh && php artisan test',
    context: safeContext,
  });

  assert.equal(result.allowed, false);
  assert.ok(result.staticFindings.includes('migrate:fresh'));
});

test('DROP DATABASE is denied', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, {
    command: 'mysql -e "DROP DATABASE application"',
    context: safeContext,
  });

  assert.equal(result.allowed, false);
  assert.ok(result.staticFindings.includes('DROP DATABASE'));
});

test('php artisan test without database evidence requires human review', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, { command: 'php artisan test' });

  assert.equal(result.dangerous, 0.1);
  assert.equal(JSON.parse(JSON.stringify(result)).dangerous, 0.1);
  assert.equal(result.allowed, false);
  assert.equal(result.needsHumanReview, true);
  assert.equal(result.decision, 'review');
});

test('review approval allows only the unchanged Safety Fingerprint', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const input = { command: 'php artisan test --filter=HumanReviewApprovalTest' };
  const first = await evaluateTest(config, input);
  assert.equal(first.decision, 'review');
  assert.ok(first.reviewId);
  transitionHumanReview(openDatabase(), first.reviewId, 'approve', new Date().toISOString());
  const approved = await evaluateTest(config, input);
  assert.equal(approved.decision, 'allow');
  assert.equal(approved.allowed, true);
  const changed = await evaluateTest(config, { ...input, command: 'php artisan test --filter=HumanReviewApprovalTestChanged' });
  assert.equal(changed.decision, 'review');
  assert.notEqual(changed.reviewId, first.reviewId);
});

test('provider changes and API failures cannot reuse a prior Human Approval', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const input = { command: 'php artisan test --filter=ProviderApprovalBoundaryTest' };
  const first = await evaluateTest(config, input);
  assert.ok(first.reviewId);
  transitionHumanReview(openDatabase(), first.reviewId, 'approve', new Date().toISOString());

  const direct = { provider: 'typesafe', apiKey: 'typesafe-secret', requestedModel: 'jev-1.13.0' };
  globalThis.fetch = async () => { throw new Error('network failure'); };
  const changedProvider = await evaluateTest(direct, input);
  assert.equal(changedProvider.decision, 'review');
  assert.equal(changedProvider.allowed, false);
  assert.equal(changedProvider.errorCode, 'JEV_NETWORK_ERROR');
  assert.notEqual(changedProvider.reviewId, first.reviewId);

  const sameProviderFailure = await evaluateTest(config, input);
  assert.equal(sameProviderFailure.decision, 'review');
  assert.equal(sameProviderFailure.allowed, false);
  assert.equal(sameProviderFailure.errorCode, 'JEV_NETWORK_ERROR');
});

test('rejected review cannot become allow', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const input = { command: 'php artisan test --filter=HumanReviewRejectTest' };
  const first = await evaluateTest(config, input);
  assert.ok(first.reviewId);
  transitionHumanReview(openDatabase(), first.reviewId, 'reject', new Date().toISOString());
  const second = await evaluateTest(config, input);
  assert.equal(second.decision, 'review');
  assert.equal(second.allowed, false);
});

test('Human Approval cannot override a later deny', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const input = { command: 'php artisan test --filter=HumanReviewThenDenyTest' };
  const first = await evaluateTest(config, input);
  assert.ok(first.reviewId);
  transitionHumanReview(openDatabase(), first.reviewId, 'approve', new Date().toISOString());
  const denied = await evaluateTest(config, { ...input, command: 'php artisan test --filter=HumanReviewThenDenyTest && DROP DATABASE app' });
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.allowed, false);
});

test('changing a supplied test file invalidates its Human Approval', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const cwd = mkdtempSync('/tmp/jev-human-file-');
  mkdirSync(join(cwd, 'tests'));
  writeFileSync(join(cwd, 'tests', 'Approval.test.js'), 'test("original", () => {});\n');
  const input = { command: 'npm test -- Approval.test.js', cwd, testFiles: ['tests/Approval.test.js'] };
  const first = await evaluateTest(config, input);
  assert.equal(first.decision, 'review');
  assert.ok(first.reviewId);
  transitionHumanReview(openDatabase(), first.reviewId, 'approve', new Date().toISOString());
  assert.equal((await evaluateTest(config, input)).decision, 'allow');
  writeFileSync(join(cwd, 'tests', 'Approval.test.js'), 'test("changed", () => {});\n');
  const changed = await evaluateTest(config, input);
  assert.equal(changed.decision, 'review');
  assert.notEqual(changed.reviewId, first.reviewId);
  rmSync(cwd, { recursive: true, force: true });
});

test('all per-file Human Reviews are required for a multi-file test request', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const cwd = mkdtempSync('/tmp/jev-human-files-');
  mkdirSync(join(cwd, 'tests'));
  writeFileSync(join(cwd, 'tests', 'One.test.js'), 'test("one", () => {});\n');
  writeFileSync(join(cwd, 'tests', 'Two.test.js'), 'test("two", () => {});\n');
  const input = { command: 'npm test', cwd, testFiles: ['tests/One.test.js', 'tests/Two.test.js'] };
  const first = await evaluateTest(config, input);
  assert.equal(first.decision, 'review');
  assert.equal(first.reviewIds.length, 2);
  transitionHumanReview(openDatabase(), first.reviewIds[0], 'approve', new Date().toISOString());
  assert.equal((await evaluateTest(config, input)).decision, 'review');
  transitionHumanReview(openDatabase(), first.reviewIds[1], 'approve', new Date().toISOString());
  assert.equal((await evaluateTest(config, input)).decision, 'allow');
  rmSync(cwd, { recursive: true, force: true });
});

test('changing Project Policy invalidates approval and a new deny remains deny', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const cwd = mkdtempSync('/tmp/jev-human-policy-');
  const policyPath = join(cwd, '.jev-policy.json');
  writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [{ name: 'review-test', match: { type: 'contains', value: 'npm test' }, decision: 'review', category: 'scope', reason: 'Project review.' }] }));
  const input = { command: 'npm test', cwd };
  const first = await evaluateTest(config, input);
  assert.equal(first.decision, 'review');
  assert.ok(first.reviewId);
  transitionHumanReview(openDatabase(), first.reviewId, 'approve', new Date().toISOString());
  assert.equal((await evaluateTest(config, input)).decision, 'allow');
  writeFileSync(policyPath, JSON.stringify({ version: 1, rules: [{ name: 'deny-test', match: { type: 'contains', value: 'npm test' }, decision: 'deny', category: 'scope', reason: 'Project deny.' }] }));
  const denied = await evaluateTest(config, input);
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.allowed, false);
  rmSync(cwd, { recursive: true, force: true });
});

test('isolated test environment can be allowed when Jev reports low risk', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, {
    command: 'php artisan test --filter=ApplicationTest',
    testCode: 'class ApplicationTest extends TestCase {}',
    context: safeContext,
    ...safeRuntimeEvidence,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.decision, 'allow');
});

test('SQLite memory configuration without runtime guard requires human review', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, {
    command: 'php artisan test',
    context: safeContext,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.needsHumanReview, true);
  assert.equal(result.decision, 'review');
});

test('runtime guard suppresses the unconfirmed persistent database finding', async () => {
  let requestBody;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(init.body);
    return lowRiskResponse();
  };
  const result = await evaluateTest(config, {
    command: 'php artisan test',
    context: `${safeContext}\nMySQL/MariaDB is never used as a fallback`,
    ...safeRuntimeEvidence,
  });

  assert.equal(result.allowed, true);
  assert.equal(result.staticFindings.includes('persistent database target is not confirmed as test-only'), false);
  assert.deepEqual(requestBody.input.state.runtimeDatabase, safeRuntimeEvidence.runtimeDatabase);
});

test('runtime guard with a destructive command is still denied', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, {
    command: 'php artisan migrate:fresh && php artisan test',
    ...safeRuntimeEvidence,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.decision, 'deny');
  assert.ok(result.staticFindings.includes('migrate:fresh'));
});

test('Jev failure fails closed', async () => {
  globalThis.fetch = async () => {
    throw new Error('network failure');
  };
  const result = await evaluateTest(config, {
    command: 'php artisan test',
    context: safeContext,
  });

  assert.equal(result.allowed, false);
  assert.equal(result.needsHumanReview, true);
  assert.equal(result.decision, 'review');
  assert.equal(result.errorCode, 'JEV_NETWORK_ERROR');
});

test('secret values are redacted before sending state to Jev', async () => {
  let requestBody;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(init.body);
    return lowRiskResponse();
  };
  await evaluateTest(config, {
    command: 'php artisan test --token=secret-token',
    context: `${safeContext}\nDB_PASSWORD=super-secret\nCLOUDFLARE_API_TOKEN=another-secret`,
  });

  const serialized = JSON.stringify(requestBody);
  assert.equal(serialized.includes('super-secret'), false);
  assert.equal(serialized.includes('another-secret'), false);
  assert.equal(serialized.includes('secret-token'), false);
});

test('Vitest with mocked services and isolated resources can be allowed', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, {
    command: 'npm test',
    framework: 'vitest',
    environment: 'testing',
    isolation: { temporaryFilesystem: true, mockedExternalServices: true },
    runtime: { productionAccess: false, persistentStorageAccess: false, networkAccess: false },
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.allowed, true);
});

test('Vitest production API mutation is denied by static policy', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, {
    command: 'npm test',
    framework: 'vitest',
    testCode: "await fetch('https://api.production.example/orders', { method: 'POST' })",
    runtime: { productionAccess: true, networkAccess: true },
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.allowed, false);
  assert.ok(result.staticFindings.some((finding) => finding.includes('production')));
});

test('pytest with an ephemeral database can be allowed', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, {
    command: 'pytest',
    framework: 'pytest',
    environment: 'testing',
    isolation: { ephemeralDatabase: true },
    runtime: { productionAccess: false, persistentStorageAccess: false },
  });
  assert.equal(result.decision, 'allow');
});

test('pytest truncating a persistent database is denied', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, {
    command: 'pytest',
    framework: 'pytest',
    testCode: 'connection.execute("TRUNCATE users")',
    runtime: { persistentStorageAccess: true },
  });
  assert.equal(result.decision, 'deny');
  assert.ok(result.staticFindings.includes('TRUNCATE'));
});

test('framework omission with no isolation evidence requires review', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const result = await evaluateTest(config, { command: 'go test ./...' });
  assert.equal(result.decision, 'review');
  assert.equal(result.needsHumanReview, true);
});

test('evaluates and caches multiple test files independently', async () => {
  const config = pinnedConfig;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return modelResponse(config.provider); };
  const cwd = mkdtempSync('/tmp/jev-files-');
  mkdirSync(join(cwd, 'tests'));
  for (const file of ['Test1.php', 'Test2.php', 'Test3.php']) writeFileSync(join(cwd, 'tests', file), `<?php // ${file}\n`);
  const input = { command: 'vitest', cwd, framework: 'vitest', environment: 'testing', testFiles: ['tests/Test1.php', 'tests/Test2.php', 'tests/Test3.php'], isolation: { ephemeralDatabase: true, mockedExternalServices: true }, runtime: { productionAccess: false, persistentStorageAccess: false, networkAccess: false } };
  await evaluateTest(config, input);
  assert.equal(calls, 3);
  writeFileSync(join(cwd, 'tests', 'Test4.php'), '<?php // Test4\n');
  const second = await evaluateTest(config, { ...input, testFiles: [...input.testFiles, 'tests/Test4.php'] });
  assert.equal(calls, 4);
  assert.equal(second.decision, 'allow');
  rmSync(cwd, { recursive: true, force: true });
});

test('reports missing test files before calling Jev', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return lowRiskResponse(); };
  const cwd = mkdtempSync('/tmp/jev-missing-file-');
  mkdirSync(join(cwd, 'tests'));
  const result = await evaluateTest(config, { command: 'npm test', cwd, testFiles: ['tests/Missing.test.js'] });
  assert.equal(result.ok, false);
  assert.equal(result.allowed, false);
  assert.equal(result.needsHumanReview, false);
  assert.equal(result.errorCode, 'TEST_FILE_VALIDATION_ERROR');
  assert.deepEqual(result.fileErrors?.map(({ file, code }) => ({ file, code })), [{ file: 'tests/Missing.test.js', code: 'TEST_FILE_NOT_FOUND' }]);
  assert.deepEqual(result.categories, []);
  assert.equal(result.riskScore, null);
  assert.equal(result.policyVersion, 'unavailable');
  assert.equal(result.reviewId, undefined);
  assert.equal(calls, 0);
  rmSync(cwd, { recursive: true, force: true });
});

test('preflights all requested test files before evaluating any of them', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return lowRiskResponse(); };
  const cwd = mkdtempSync('/tmp/jev-preflight-files-');
  mkdirSync(join(cwd, 'tests'));
  writeFileSync(join(cwd, 'tests', 'Present.test.js'), 'test("present", () => {});\n');
  const result = await evaluateTest(config, { command: 'npm test', cwd, testFiles: ['tests/Present.test.js', 'tests/Missing1.test.js', 'tests/Missing2.test.js'] });
  assert.equal(result.errorCode, 'TEST_FILE_VALIDATION_ERROR');
  assert.deepEqual(result.fileErrors?.map((error) => error.code), ['TEST_FILE_NOT_FOUND', 'TEST_FILE_NOT_FOUND']);
  assert.equal(calls, 0);
  rmSync(cwd, { recursive: true, force: true });
});

test('reports an MCP-invisible cwd as an input error', async () => {
  const parent = mkdtempSync('/tmp/jev-missing-cwd-');
  const cwd = join(parent, 'not-present');
  const result = await evaluateTest(config, { command: 'npm test', cwd, testFiles: ['tests/Example.test.js'] });
  assert.equal(result.errorCode, 'TEST_CWD_NOT_FOUND');
  assert.equal(result.needsHumanReview, false);
  assert.deepEqual(result.categories, []);
  assert.equal(result.riskScore, null);
  assert.equal(result.policyVersion, 'unavailable');
  rmSync(parent, { recursive: true, force: true });
});

test('distinguishes outside-cwd, symlink, and non-regular test files', async () => {
  const parent = mkdtempSync('/tmp/jev-invalid-files-');
  const cwd = join(parent, 'project');
  mkdirSync(join(cwd, 'tests'), { recursive: true });
  writeFileSync(join(parent, 'outside.test.js'), 'test("outside", () => {});\n');
  symlinkSync(join(parent, 'outside.test.js'), join(cwd, 'tests', 'Link.test.js'));
  mkdirSync(join(cwd, 'tests', 'Directory.test.js'));
  const result = await evaluateTest(config, {
    command: 'npm test', cwd,
    testFiles: ['../outside.test.js', 'tests/Link.test.js', 'tests/Directory.test.js'],
  });
  assert.deepEqual(result.fileErrors?.map((error) => error.code), ['TEST_FILE_OUTSIDE_CWD', 'TEST_FILE_SYMLINK', 'TEST_FILE_NOT_REGULAR']);
  rmSync(parent, { recursive: true, force: true });
});

test('shared safety context changes invalidate dependent test files', async () => {
  const config = pinnedConfig;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return modelResponse(config.provider); };
  const cwd = mkdtempSync('/tmp/jev-shared-');
  mkdirSync(join(cwd, 'tests'));
  for (const file of ['Test1.php', 'Test2.php', 'Test3.php']) writeFileSync(join(cwd, 'tests', file), `<?php // ${file}\n`);
  const input = { command: 'vitest', cwd, framework: 'vitest', environment: 'testing', testFiles: ['tests/Test1.php', 'tests/Test2.php', 'tests/Test3.php'], isolation: { ephemeralDatabase: true, mockedExternalServices: true }, runtime: { productionAccess: false, persistentStorageAccess: false, networkAccess: false } };
  await evaluateTest(config, input);
  assert.equal(calls, 3);
  writeFileSync(join(cwd, 'tests', 'TestCase.php'), '<?php // changed shared context\n');
  await evaluateTest(config, input);
  assert.equal(calls, 6);
  rmSync(cwd, { recursive: true, force: true });
});

function profileV2Project() {
  const cwd = mkdtempSync('/tmp/jev-environment-v2-');
  for (const directory of ['.jev', 'bin', 'config', 'app', 'tests/Support', 'tests/Feature']) mkdirSync(join(cwd, directory), { recursive: true });
  writeFileSync(join(cwd, 'bin', 'safe-test-runner'), '#!/bin/sh\nexit 1\n');
  writeFileSync(join(cwd, 'phpunit.xml'), '<phpunit/>\n');
  writeFileSync(join(cwd, 'config', 'database.php'), '<?php return [];\n');
  writeFileSync(join(cwd, 'app', 'Service.php'), '<?php class Service {}\n');
  writeFileSync(join(cwd, 'tests', 'Support', 'Helper.php'), '<?php trait Helper {}\n');
  writeFileSync(join(cwd, 'composer.lock'), '{}\n');
  writeFileSync(join(cwd, '.jev', 'test-safety.json'), JSON.stringify({
    version: 2,
    name: 'laravel-safe-runner',
    framework: 'laravel',
    environment: 'testing',
    runner: {
      id: 'laravel-safe-v1', executable: 'bin/safe-test-runner', files: ['bin/safe-test-runner'], fixedArgs: [], shell: false,
      selectors: { filePatterns: ['tests/**'], allowFilter: true },
    },
    environmentFiles: ['phpunit.xml', 'config/database.php'],
    codeReviewRoots: ['app', 'tests/Support', 'composer.lock'],
    resources: {
      database: { policy: 'sqlite-memory', rejectFallback: true, rejectAdditionalConnections: true },
      filesystem: { writableRoots: ['storage/framework/testing'] },
      network: { policy: 'deny' }, credentials: { policy: 'deny' },
    },
  }));
  return cwd;
}

function profileV2Input(cwd, file = 'tests/Feature/SafeTest.php', filter) {
  return {
    command: 'bin/safe-test-runner', cwd, framework: 'laravel', environment: 'testing', testFiles: [file],
    execution: { runnerId: 'laravel-safe-v1', files: [file], ...(filter === undefined ? {} : { filter }) },
  };
}

test('Safety Profile v2 separates one-time environment approval from changed test review', async () => {
  const config = pinnedConfig;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return modelResponse(config.provider); };
  const cwd = profileV2Project();
  const testPath = join(cwd, 'tests', 'Feature', 'SafeTest.php');
  writeFileSync(testPath, '<?php use Illuminate\\Foundation\\Testing\\RefreshDatabase; class SafeTest { use RefreshDatabase; }\n');
  const input = profileV2Input(cwd);
  const pending = await evaluateTest(config, input);
  assert.equal(pending.decision, 'review');
  assert.equal(pending.environmentAssessment.status, 'pending');
  assert.ok(pending.environmentReviewId);
  assert.equal(pending.environmentAssessment.scope.runner.id, 'laravel-safe-v1');
  assert.equal(pending.environmentAssessment.scope.resources.database.policy, 'sqlite-memory');
  assert.equal(calls, 0);
  const now = new Date();
  transitionEnvironmentApproval(openDatabase(), pending.environmentReviewId, 'approve', now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString());

  const approved = await evaluateTest(config, input);
  assert.equal(approved.decision, 'allow');
  assert.equal(approved.environmentAssessment.status, 'approved');
  assert.ok(approved.executionAssessment.ticket);
  assert.equal(calls, 1);

  writeFileSync(testPath, '<?php use Illuminate\\Foundation\\Testing\\RefreshDatabase; class SafeTest { use RefreshDatabase; public function testChanged() { $this->assertTrue(true); } }\n');
  const changed = await evaluateTest(config, input);
  assert.equal(changed.decision, 'allow');
  assert.equal(changed.environmentAssessment.approvalId, approved.environmentAssessment.approvalId);
  assert.equal(calls, 2);

  const filtered = await evaluateTest(config, profileV2Input(cwd, 'tests/Feature/SafeTest.php', 'SafeTest::testChanged'));
  assert.equal(filtered.decision, 'allow');
  assert.equal(filtered.codeAssessment.status, 'cache-hit');
  assert.equal(filtered.environmentAssessment.approvalId, approved.environmentAssessment.approvalId);
  assert.equal(calls, 2);

  writeFileSync(join(cwd, 'tests', 'Feature', 'NewTest.php'), '<?php class NewTest { public function testNew() { $this->assertTrue(true); } }\n');
  const added = await evaluateTest(config, profileV2Input(cwd, 'tests/Feature/NewTest.php'));
  assert.equal(added.decision, 'allow');
  assert.equal(added.environmentAssessment.approvalId, approved.environmentAssessment.approvalId);
  assert.equal(calls, 3);
  rmSync(cwd, { recursive: true, force: true });
});

test('Safety Profile v2 invalidates code cache and environment approval on the correct boundaries', async () => {
  const config = pinnedConfig;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return modelResponse(config.provider); };
  const cwd = profileV2Project();
  const testPath = join(cwd, 'tests', 'Feature', 'BoundaryTest.php');
  writeFileSync(testPath, '<?php class BoundaryTest {}\n');
  const input = profileV2Input(cwd, 'tests/Feature/BoundaryTest.php');
  const pending = await evaluateTest(config, input);
  const now = new Date();
  transitionEnvironmentApproval(openDatabase(), pending.environmentReviewId, 'approve', now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
  assert.equal((await evaluateTest(config, input)).decision, 'allow');
  assert.equal(calls, 1);

  writeFileSync(join(cwd, 'app', 'Service.php'), '<?php class Service { public function changed() {} }\n');
  const appChanged = await evaluateTest(config, input);
  assert.equal(appChanged.decision, 'allow');
  assert.equal(appChanged.environmentAssessment.status, 'approved');
  assert.equal(calls, 2);

  writeFileSync(join(cwd, 'config', 'database.php'), '<?php return ["default" => "mysql"];\n');
  const environmentChanged = await evaluateTest(config, input);
  assert.equal(environmentChanged.decision, 'review');
  assert.equal(environmentChanged.environmentAssessment.status, 'pending');
  assert.notEqual(environmentChanged.environmentReviewId, pending.environmentReviewId);
  assert.equal(calls, 2);
  rmSync(cwd, { recursive: true, force: true });
});

test('Safety Profile v2 never lets environment approval override deny or selector scope', async () => {
  globalThis.fetch = async () => lowRiskResponse();
  const cwd = profileV2Project();
  writeFileSync(join(cwd, 'tests', 'Feature', 'DenyTest.php'), '<?php class DenyTest { public function testIt() { DB::statement("DROP DATABASE app"); } }\n');
  const input = profileV2Input(cwd, 'tests/Feature/DenyTest.php');
  const denied = await evaluateTest(config, input);
  assert.equal(denied.decision, 'deny');
  assert.equal(denied.environmentReviewId, undefined);

  writeFileSync(join(cwd, 'OutsideTest.php'), '<?php class OutsideTest {}\n');
  const outside = await evaluateTest(config, profileV2Input(cwd, 'OutsideTest.php'));
  assert.equal(outside.decision, 'review');
  assert.equal(outside.errorCode, 'INVALID_EXECUTION_SELECTION');
  rmSync(cwd, { recursive: true, force: true });
});

test('Safety Profile v2 does not turn policy review or Jev failure into allow', async () => {
  const cwd = profileV2Project();
  writeFileSync(join(cwd, 'tests', 'Feature', 'ReviewTest.php'), '<?php class ReviewTest {}\n');
  const input = profileV2Input(cwd, 'tests/Feature/ReviewTest.php');
  globalThis.fetch = async () => lowRiskResponse();
  const pending = await evaluateTest(config, input);
  const now = new Date();
  transitionEnvironmentApproval(openDatabase(), pending.environmentReviewId, 'approve', now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
  const direct = { provider: 'typesafe', apiKey: 'typesafe-secret', requestedModel: 'jev-1.13.0' };
  globalThis.fetch = async () => new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { test_dangerous: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  const providerChanged = await evaluateTest(direct, input);
  assert.equal(providerChanged.environmentAssessment.status, 'approved');
  assert.equal(providerChanged.codeAssessment.status, 'evaluated');

  globalThis.fetch = async () => lowRiskResponse();
  writeFileSync(join(cwd, '.jev-policy.json'), JSON.stringify({ version: 1, rules: [{ name: 'manual-review', match: { type: 'contains', value: 'safe-test-runner' }, decision: 'review', category: 'scope', reason: 'Manual review remains required.' }] }));
  const policyReview = await evaluateTest(config, input);
  assert.equal(policyReview.environmentAssessment.status, 'approved');
  assert.equal(policyReview.decision, 'review');
  assert.equal(policyReview.allowed, false);

  writeFileSync(join(cwd, '.jev-policy.json'), JSON.stringify({ version: 1, rules: [] }));
  writeFileSync(join(cwd, 'tests', 'Feature', 'ReviewTest.php'), '<?php class ReviewTest { public function changed() {} }\n');
  globalThis.fetch = async () => { throw new Error('network failure'); };
  const jevFailure = await evaluateTest(config, input);
  assert.equal(jevFailure.environmentAssessment.status, 'approved');
  assert.equal(jevFailure.decision, 'review');
  assert.equal(jevFailure.allowed, false);
  assert.equal(jevFailure.errorCode, 'JEV_NETWORK_ERROR');
  rmSync(cwd, { recursive: true, force: true });
});

test('an alias actual-model change replaces code approval but preserves Environment Approval', async (t) => {
  const cwd = profileV2Project();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'tests', 'Feature', 'ModelTest.php'), '<?php class ModelTest {}\n');
  const input = profileV2Input(cwd, 'tests/Feature/ModelTest.php');
  const selected = { ...pinnedConfig, requestedModel: 'jev-latest' };
  let model = 'jev-1.13.0';
  globalThis.fetch = async () => modelResponse('typesafe', 0.5, model);
  const environmentPending = await evaluateTest(selected, input);
  const now = new Date();
  transitionEnvironmentApproval(openDatabase(), environmentPending.environmentReviewId, 'approve', now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
  const codePending = await evaluateTest(selected, input);
  transitionHumanReview(openDatabase(), codePending.reviewId, 'approve', now.toISOString());
  const approved = await evaluateTest(selected, input);
  assert.equal(approved.decision, 'allow');
  assert.ok(approved.executionAssessment.ticket);
  model = 'jev-1.14.0';
  const changed = await evaluateTest(selected, input);
  assert.equal(changed.decision, 'review');
  assert.notEqual(changed.reviewId, codePending.reviewId);
  assert.equal(changed.environmentAssessment.status, 'approved');
  assert.equal(changed.environmentAssessment.approvalId, approved.environmentAssessment.approvalId);
  assert.equal(changed.environmentReviewId, undefined);
  assert.equal(changed.executionAssessment.ticket, undefined);
  globalThis.fetch = async () => { throw new Error('mock provider failure'); };
  const otherProvider = await evaluateTest(config, input);
  // A provider failure cannot invalidate the independently approved environment.
  assert.equal(otherProvider.environmentAssessment.status, 'approved');
  assert.equal(otherProvider.environmentAssessment.approvalId, approved.environmentAssessment.approvalId);
  assert.equal(otherProvider.errorCode, 'JEV_NETWORK_ERROR');
});
