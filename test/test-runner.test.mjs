import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { evaluateTest } from '../dist/test-checker.js';
import { runApprovedTest, ApprovedTestExecutionError } from 'jev-mcp-server/runner';
import { openDatabase, resetDatabaseForTests } from '../dist/storage/sqlite.js';
import { revokeEnvironmentApproval, transitionEnvironmentApproval } from '../dist/storage/environment-approval.js';
import { sha256 } from '../dist/safety-fingerprint.js';

const config = { provider: 'typesafe', apiKey: 'test-key', requestedModel: 'jev-1.13.0' };
const directories = [];
const originalDbPath = process.env.JEV_CACHE_DB_PATH;

afterEach(() => {
  delete globalThis.fetch;
  resetDatabaseForTests();
  if (originalDbPath === undefined) delete process.env.JEV_CACHE_DB_PATH;
  else process.env.JEV_CACHE_DB_PATH = originalDbPath;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function lowRiskResponse() {
  return new Response(JSON.stringify({ model: config.requestedModel, answers: { test_dangerous: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
}

function createProject() {
  const cwd = mkdtempSync(join(tmpdir(), 'jev-approved-runner-'));
  directories.push(cwd);
  for (const directory of ['.jev', 'bin', 'config', 'app', 'tests/Feature', 'runtime']) mkdirSync(join(cwd, directory), { recursive: true });
  writeFileSync(join(cwd, 'bin/safe-runner.mjs'), '/* approved test runner fixture */\n');
  writeFileSync(join(cwd, 'config/testing.json'), '{"database":"memory"}\n');
  writeFileSync(join(cwd, 'app/service.js'), 'export const value = 1;\n');
  writeFileSync(join(cwd, 'tests/Feature/Safe.test.js'), 'assertSafe();\n');
  writeFileSync(join(cwd, '.jev/test-safety.json'), JSON.stringify({
    version: 2, name: 'fixture-runner', framework: 'vitest', environment: 'testing',
    runner: { id: 'fixture-v1', executable: 'bin/safe-runner.mjs', files: ['bin/safe-runner.mjs'], fixedArgs: ['--run'], shell: false, selectors: { filePatterns: ['tests/**'], allowFilter: true } },
    environmentFiles: ['config/testing.json'], codeReviewRoots: ['app'],
    resources: {
      database: { policy: 'sqlite-memory', rejectFallback: true, rejectAdditionalConnections: true },
      filesystem: { writableRoots: ['runtime'] }, network: { policy: 'deny' }, credentials: { policy: 'deny' },
    },
  }));
  return cwd;
}

function inputFor(cwd, filter) {
  return {
    command: 'bin/safe-runner.mjs', cwd, framework: 'vitest', environment: 'testing', testFiles: ['tests/Feature/Safe.test.js'],
    execution: { runnerId: 'fixture-v1', files: ['tests/Feature/Safe.test.js'], ...(filter === undefined ? {} : { filter }) },
  };
}

function safeEnforcement() {
  return {
    immutableWorkspace: true, configCacheActive: false,
    database: { primary: { connection: 'sqlite', database: ':memory:', temporary: true }, fallbackConnections: [], additionalConnections: [] },
    filesystem: { enforced: true, writableRoots: ['runtime'] },
    network: { enforced: true, policy: 'deny', allowedHosts: [] },
    credentials: { enforced: true, policy: 'deny', allowedNames: [] },
  };
}

function adapter(enforcement = safeEnforcement(), execute = async ({ plan }) => plan) {
  return { prepare: async () => enforcement, execute };
}

async function approvedTicket(cwd, input = inputFor(cwd)) {
  process.env.JEV_CACHE_DB_PATH = ':memory:';
  globalThis.fetch = async () => lowRiskResponse();
  const pending = await evaluateTest(config, input);
  assert.equal(pending.environmentAssessment.status, 'pending');
  const now = new Date();
  transitionEnvironmentApproval(openDatabase(), pending.environmentReviewId, 'approve', now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString());
  const allowed = await evaluateTest(config, input);
  assert.equal(allowed.decision, 'allow');
  assert.ok(allowed.executionAssessment.ticket);
  return allowed;
}

async function rejectsCode(code, operation) {
  await assert.rejects(operation, (error) => error instanceof ApprovedTestExecutionError && error.code === code);
}

test('approved runner validates, consumes, and executes an exact ticket once', async () => {
  const cwd = createProject();
  const input = inputFor(cwd);
  const allowed = await approvedTicket(cwd, input);
  const plan = await runApprovedTest({ ticket: allowed.executionAssessment.ticket, config, input, adapter: adapter() });
  assert.equal(plan.runnerId, 'fixture-v1');
  assert.deepEqual(plan.fixedArgs, ['--run']);
  assert.deepEqual(plan.files, ['tests/Feature/Safe.test.js']);
  assert.equal(plan.shell, false);
  await rejectsCode('TICKET_USED', () => runApprovedTest({ ticket: allowed.executionAssessment.ticket, config, input, adapter: adapter() }));
});

test('code, runner, project, and selection changes invalidate their tickets', async () => {
  for (const change of [
    (cwd, input) => writeFileSync(join(cwd, 'tests/Feature/Safe.test.js'), 'changedTest();\n'),
    (cwd, input) => writeFileSync(join(cwd, 'app/service.js'), 'export const value = 2;\n'),
    (cwd, input) => writeFileSync(join(cwd, 'bin/safe-runner.mjs'), '/* changed runner */\n'),
    (cwd, input) => writeFileSync(join(cwd, 'config/testing.json'), '{"database":"persistent"}\n'),
    (cwd, input) => writeFileSync(join(cwd, '.jev-policy.json'), JSON.stringify({ version: 1, rules: [] })),
    (cwd, input) => { input.execution.filter = 'changed-filter'; },
  ]) {
    resetDatabaseForTests(); process.env.JEV_CACHE_DB_PATH = ':memory:';
    const cwd = createProject();
    const input = inputFor(cwd);
    const allowed = await approvedTicket(cwd, input);
    change(cwd, input);
    await rejectsCode('TICKET_IDENTITY_MISMATCH', () => runApprovedTest({ ticket: allowed.executionAssessment.ticket, config, input, adapter: adapter() }));
  }
  resetDatabaseForTests(); process.env.JEV_CACHE_DB_PATH = ':memory:';
  const first = createProject();
  const allowed = await approvedTicket(first, inputFor(first));
  const second = createProject();
  await rejectsCode('TICKET_IDENTITY_MISMATCH', () => runApprovedTest({ ticket: allowed.executionAssessment.ticket, config, input: inputFor(second), adapter: adapter() }));

  resetDatabaseForTests(); process.env.JEV_CACHE_DB_PATH = ':memory:';
  const runnerProject = createProject();
  const runnerInput = inputFor(runnerProject);
  const runnerTicket = await approvedTicket(runnerProject, runnerInput);
  runnerInput.execution.runnerId = 'different-runner';
  await rejectsCode('INVALID_EXECUTION_SELECTION', () => runApprovedTest({ ticket: runnerTicket.executionAssessment.ticket, config, input: runnerInput, adapter: adapter() }));

  resetDatabaseForTests(); process.env.JEV_CACHE_DB_PATH = ':memory:';
  const modelProject = createProject();
  const modelInput = inputFor(modelProject);
  const modelTicket = await approvedTicket(modelProject, modelInput);
  await rejectsCode('TICKET_IDENTITY_MISMATCH', () => runApprovedTest({
    ticket: modelTicket.executionAssessment.ticket,
    config: { ...config, requestedModel: 'jev-9.9.9' },
    input: modelInput,
    adapter: adapter(),
  }));
});

test('resource mismatch revokes the ticket before execution', async () => {
  const cases = [
    ['DATABASE_SCOPE_MISMATCH', (value) => value.database.additionalConnections.push('production')],
    ['DATABASE_SCOPE_MISMATCH', (value) => { value.database.primary.database = 'persistent.sqlite'; value.database.primary.temporary = false; }],
    ['CONFIG_CACHE_ACTIVE', (value) => { value.configCacheActive = true; }],
    ['WORKSPACE_NOT_IMMUTABLE', (value) => { value.immutableWorkspace = false; }],
    ['FILESYSTEM_SCOPE_MISMATCH', (value) => value.filesystem.writableRoots.push('../outside')],
    ['NETWORK_SCOPE_MISMATCH', (value) => { value.network.policy = 'allowlist'; value.network.allowedHosts.push('example.com'); }],
    ['CREDENTIAL_SCOPE_MISMATCH', (value) => { value.credentials.policy = 'allowlist'; value.credentials.allowedNames.push('PRODUCTION_TOKEN'); }],
  ];
  for (const [code, mutate] of cases) {
    resetDatabaseForTests(); process.env.JEV_CACHE_DB_PATH = ':memory:';
    const cwd = createProject();
    const input = inputFor(cwd);
    const allowed = await approvedTicket(cwd, input);
    const unsafe = safeEnforcement();
    mutate(unsafe);
    await rejectsCode(code, () => runApprovedTest({ ticket: allowed.executionAssessment.ticket, config, input, adapter: adapter(unsafe) }));
    await rejectsCode('TICKET_REVOKED', () => runApprovedTest({ ticket: allowed.executionAssessment.ticket, config, input, adapter: adapter() }));
  }
});

test('expired or revoked approval tickets cannot execute', async () => {
  const cwd = createProject();
  const input = inputFor(cwd);
  const expired = await approvedTicket(cwd, input);
  openDatabase().prepare('UPDATE execution_tickets SET expires_at=? WHERE ticket_hash=?').run('2000-01-01T00:00:00.000Z', sha256(expired.executionAssessment.ticket));
  await rejectsCode('TICKET_EXPIRED', () => runApprovedTest({ ticket: expired.executionAssessment.ticket, config, input, adapter: adapter() }));

  const current = await evaluateTest(config, input);
  const approvalId = current.environmentAssessment.approvalId;
  revokeEnvironmentApproval(openDatabase(), approvalId, new Date().toISOString());
  await rejectsCode('TICKET_REVOKED', () => runApprovedTest({ ticket: current.executionAssessment.ticket, config, input, adapter: adapter() }));

  const approvalExpired = await approvedTicket(cwd, input);
  openDatabase().prepare('UPDATE environment_approvals SET expires_at=? WHERE approval_id=?').run('2000-01-01T00:00:00.000Z', approvalExpired.environmentAssessment.approvalId);
  await rejectsCode('TICKET_APPROVAL_INVALID', () => runApprovedTest({ ticket: approvalExpired.executionAssessment.ticket, config, input, adapter: adapter() }));
});

test('a launch failure spends the ticket and concurrent consumers execute at most once', async () => {
  const cwd = createProject();
  const input = inputFor(cwd);
  const failed = await approvedTicket(cwd, input);
  await assert.rejects(() => runApprovedTest({ ticket: failed.executionAssessment.ticket, config, input, adapter: adapter(safeEnforcement(), async () => { throw new Error('fixture launch failed'); }) }), /fixture launch failed/u);
  await rejectsCode('TICKET_USED', () => runApprovedTest({ ticket: failed.executionAssessment.ticket, config, input, adapter: adapter() }));

  const allowed = await evaluateTest(config, input);
  let executions = 0;
  const concurrent = adapter(safeEnforcement(), async () => { executions += 1; return 'ran'; });
  const results = await Promise.allSettled([
    runApprovedTest({ ticket: allowed.executionAssessment.ticket, config, input, adapter: concurrent }),
    runApprovedTest({ ticket: allowed.executionAssessment.ticket, config, input, adapter: concurrent }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(executions, 1);
});
