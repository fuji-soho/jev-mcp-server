import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { evaluateCommand } from '../dist/command-checker.js';

const config = { provider: 'cloudflare', accountId: 'test-account', apiToken: 'test-token', requestedModel: 'typesafe/jev' };

function jevResponse(score) {
  return new Response(JSON.stringify({
    success: true,
    result: {
      state: 'Completed',
      result: { model: 'typesafe/jev', answers: { command_dangerous: { type: 'noul', noul: score } } },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { delete globalThis.fetch; delete process.env.JEV_LOG_PATH; });

test('read-only command can be allowed with low Jev risk', async () => {
  let requestBody;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(init.body);
    return jevResponse(0.1);
  };
  const result = await evaluateCommand(config, { command: 'git status', cwd: '/workspace/project', environment: 'development' });
  assert.equal(result.decision, 'allow');
  assert.equal(result.allowed, true);
  assert.equal(requestBody.input.state.command, 'git status');
  assert.equal(requestBody.input.state.cwd, '/workspace/project');
});

test('explicit root deletion is denied by static policy even when Jev reports low risk', async () => {
  globalThis.fetch = async () => jevResponse(0.1);
  const result = await evaluateCommand(config, { command: 'rm -rf /' });
  assert.equal(result.decision, 'deny');
  assert.equal(result.allowed, false);
  assert.ok(result.staticFindings.some((finding) => finding.ruleId === 'filesystem.root-recursive-delete'));
});

test('git reset hard requires review', async () => {
  globalThis.fetch = async () => jevResponse(0.1);
  const result = await evaluateCommand(config, { command: 'git reset --hard', context: 'uncommitted changes may exist' });
  assert.equal(result.decision, 'review');
  assert.equal(result.needsHumanReview, true);
  assert.ok(result.categories.includes('git'));
});

test('production state changes require review', async () => {
  globalThis.fetch = async () => jevResponse(0.1);
  const result = await evaluateCommand(config, { command: 'systemctl restart app', environment: 'production' });
  assert.equal(result.decision, 'review');
  assert.ok(result.categories.includes('production-impact'));
});

test('Jev receives redacted command data and failures fail closed', async () => {
  let requestBody;
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(init.body);
    throw new Error('network failure');
  };
  const result = await evaluateCommand(config, { command: 'deploy --token=secret-token', context: 'API_KEY=secret-key' });
  assert.equal(result.decision, 'review');
  assert.equal(result.allowed, false);
  assert.equal(result.errorCode, 'JEV_NETWORK_ERROR');
  assert.equal(JSON.stringify(requestBody).includes('secret-token'), false);
  assert.equal(JSON.stringify(requestBody).includes('secret-key'), false);
});

test('provider and requested model changes invalidate command cache entries', async () => {
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    if (body.input) return jevResponse(0.1);
    return new Response(JSON.stringify({ model: body.model, answers: { command_dangerous: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  };
  const input = { command: 'git status --short --branch', cwd: '/workspace/provider-cache-test', environment: 'development' };
  const direct113 = { provider: 'typesafe', apiKey: 'one', requestedModel: 'jev-1.13.0' };
  const direct114 = { provider: 'typesafe', apiKey: 'two', requestedModel: 'jev-1.14.0' };
  assert.equal((await evaluateCommand(direct113, input)).allowed, true);
  assert.equal((await evaluateCommand(direct113, input)).allowed, true);
  assert.equal(calls, 1);
  assert.equal((await evaluateCommand(direct114, input)).allowed, true);
  assert.equal(calls, 2);
  assert.equal((await evaluateCommand(config, input)).allowed, true);
  assert.equal(calls, 3);
});

test('moving TypeSafe aliases are evaluated on every command check', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { command_dangerous: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  };
  const aliasConfig = { provider: 'typesafe', apiKey: 'alias-secret', requestedModel: 'jev-latest' };
  const input = { command: 'git status --porcelain=v2', cwd: '/workspace/alias-cache-test', environment: 'development' };
  assert.equal((await evaluateCommand(aliasConfig, input)).allowed, true);
  assert.equal((await evaluateCommand(aliasConfig, input)).allowed, true);
  assert.equal(calls, 2);
});

test('static deny remains deny when Jev is unavailable', async () => {
  globalThis.fetch = async () => { throw new Error('must not be called'); };
  const result = await evaluateCommand(config, { command: 'rm -rf /' });
  assert.equal(result.decision, 'deny');
  assert.equal(result.allowed, false);
});

test('TypeSafe API keys do not appear in errors, logs, or result payloads', async () => {
  const apiKey = 'typesafe-key-that-must-not-leak';
  const logPath = `/tmp/jev-key-leak-${process.pid}-${Date.now()}.log`;
  process.env.JEV_LOG_PATH = logPath;
  globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
  const result = await evaluateCommand(
    { provider: 'typesafe', apiKey, requestedModel: 'jev-1.13.0' },
    { command: 'git status --show-stash', cwd: '/workspace/key-leak-test' },
  );
  assert.equal(result.errorCode, 'JEV_API_ERROR');
  assert.equal(JSON.stringify(result).includes(apiKey), false);
  assert.equal(readFileSync(logPath, 'utf8').includes(apiKey), false);
  rmSync(logPath, { force: true });
});
