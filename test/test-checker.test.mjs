import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, afterEach } from 'node:test';
import { evaluateTest } from '../dist/test-checker.js';
import { verifySafetyProfile } from '../dist/test-safety-profile.js';

const config = {
  accountId: 'test-account',
  apiToken: 'test-token',
};

const lowRiskResponse = () => new Response(JSON.stringify({
  success: true,
  result: {
    state: 'Completed',
    result: {
      model: 'typesafe/jev',
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
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return lowRiskResponse(); };
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

test('shared safety context changes invalidate dependent test files', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return lowRiskResponse(); };
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
