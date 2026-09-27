import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { evaluateCommand } from '../dist/command-checker.js';

const config = { accountId: 'test-account', apiToken: 'test-token' };

function jevResponse(score) {
  return new Response(JSON.stringify({
    success: true,
    result: {
      state: 'Completed',
      result: { model: 'typesafe/jev', answers: { command_dangerous: { type: 'noul', noul: score } } },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { delete globalThis.fetch; });

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
