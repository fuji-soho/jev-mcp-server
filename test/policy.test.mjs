import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { evaluateCommand } from '../dist/command-checker.js';
import { findPolicyMatches, loadEffectivePolicies } from '../dist/policy.js';

const config = { accountId: 'test-account', apiToken: 'test-token' };
const temporaryDirectories = [];

function jevResponse(score) {
  return new Response(JSON.stringify({
    success: true,
    result: { state: 'Completed', result: { model: 'typesafe/jev', answers: { command_dangerous: { type: 'noul', noul: score } } } },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(async () => {
  delete globalThis.fetch;
  delete process.env.XDG_CONFIG_HOME;
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function projectWithPolicy(policy) {
  const project = await mkdtemp('/tmp/jev-policy-project-');
  temporaryDirectories.push(project);
  await writeFile(join(project, '.jev-policy.json'), JSON.stringify(policy), 'utf8');
  return project;
}

test('project deny wins over Jev allow and is reported without exposing a path', async () => {
  const project = await projectWithPolicy({ version: 1, rules: [{ name: 'deny-deploy', pattern: 'npm run deploy', decision: 'deny', category: 'deployment', reason: 'Deployments require an explicit approval.' }] });
  globalThis.fetch = async () => jevResponse(0.1);
  const result = await evaluateCommand(config, { command: 'npm run deploy', cwd: project });
  assert.equal(result.decision, 'deny');
  assert.equal(result.allowed, false);
  assert.equal(result.policyFindings[0].source, 'project');
  assert.equal(result.policyFindings[0].rule, 'deny-deploy');
  assert.equal(JSON.stringify(result).includes(project), false);
});

test('allow policy cannot weaken a built-in deny', async () => {
  const project = await projectWithPolicy({ version: 1, rules: [{ name: 'allow-root-delete', pattern: 'rm -rf /', decision: 'allow', category: 'filesystem', reason: 'Local exception.' }] });
  globalThis.fetch = async () => jevResponse(0.1);
  const result = await evaluateCommand(config, { command: 'rm -rf /', cwd: project });
  assert.equal(result.decision, 'deny');
  assert.ok(result.policyFindings.some((finding) => finding.source === 'builtin' && finding.decision === 'deny'));
  assert.ok(result.policyFindings.some((finding) => finding.source === 'project' && finding.decision === 'allow'));
});

test('user policy applies across projects', async () => {
  const configHome = await mkdtemp('/tmp/jev-policy-config-');
  temporaryDirectories.push(configHome);
  await mkdir(join(configHome, 'jev-mcp'), { recursive: true });
  await writeFile(join(configHome, 'jev-mcp', 'policy.json'), JSON.stringify({ version: 1, rules: [{ name: 'deny-force-push', match: { type: 'contains', value: 'git push --force' }, decision: 'deny', category: 'git', reason: 'Force push is prohibited.' }] }), 'utf8');
  process.env.XDG_CONFIG_HOME = configHome;
  const policies = loadEffectivePolicies(undefined, process.env);
  const result = findPolicyMatches(policies, 'git push --force origin main');
  const userFinding = result.policyFindings.find((finding) => finding.source === 'user');
  assert.equal(userFinding?.decision, 'deny');
});

test('invalid project policy fails closed before Jev is called', async () => {
  const project = await mkdtemp('/tmp/jev-policy-invalid-');
  temporaryDirectories.push(project);
  await writeFile(join(project, '.jev-policy.json'), '{ invalid json', 'utf8');
  let called = false;
  globalThis.fetch = async () => { called = true; return jevResponse(0.1); };
  const result = await evaluateCommand(config, { command: 'git status', cwd: project });
  assert.equal(result.decision, 'review');
  assert.equal(result.allowed, false);
  assert.equal(result.errorCode, 'POLICY_ERROR');
  assert.equal(called, false);
});
