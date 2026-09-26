import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { evaluateTest } from '../dist/test-checker.js';

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
