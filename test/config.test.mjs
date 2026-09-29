import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { loadConfig, resolveConfigPath } from '../dist/config.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryEnvFile(contents) {
  const directory = await mkdtemp('/tmp/jev-config-');
  temporaryDirectories.push(directory);
  const path = join(directory, '.env');
  await writeFile(path, contents, 'utf8');
  return path;
}

test('resolves the default configuration path next to the project root', () => {
  assert.equal(resolveConfigPath([], {}), resolve('/root/jev-mcp-server/.env'));
});

test('uses JEV_ENV_PATH when no CLI path is provided', () => {
  assert.equal(
    resolveConfigPath([], { JEV_ENV_PATH: '/secure/jev/.env' }),
    resolve('/secure/jev/.env'),
  );
});

test('CLI --env-file takes priority over JEV_ENV_PATH', () => {
  assert.equal(
    resolveConfigPath(['--env-file', '/cli/jev.env'], { JEV_ENV_PATH: '/env/jev.env' }),
    resolve('/cli/jev.env'),
  );
});

test('supports the --env-file=path form', () => {
  assert.equal(
    resolveConfigPath(['--env-file=/cli/jev.env'], {}),
    resolve('/cli/jev.env'),
  );
});

test('loads required credentials from the selected file', async () => {
  const path = await temporaryEnvFile([
    'CLOUDFLARE_ACCOUNT_ID=account',
    'CLOUDFLARE_API_TOKEN="token"',
  ].join('\n'));

  assert.deepEqual(loadConfig(path), {
    provider: 'cloudflare',
    accountId: 'account',
    apiToken: 'token',
    requestedModel: 'typesafe/jev',
  });
});

test('loads TypeSafe credentials without requiring Cloudflare credentials', async () => {
  const path = await temporaryEnvFile([
    'JEV_PROVIDER=typesafe',
    'TYPESAFE_API_KEY="typesafe-token"',
  ].join('\n'));

  assert.deepEqual(loadConfig(path), {
    provider: 'typesafe',
    apiKey: 'typesafe-token',
    requestedModel: 'jev-1.13.0',
  });
});

test('loads an explicit TypeSafe model', async () => {
  const path = await temporaryEnvFile([
    'JEV_PROVIDER=typesafe',
    'TYPESAFE_API_KEY=typesafe-token',
    'TYPESAFE_MODEL=jev-latest',
  ].join('\n'));
  assert.equal(loadConfig(path).requestedModel, 'jev-latest');
});

test('rejects an unknown provider without inferring from credentials', async () => {
  const path = await temporaryEnvFile([
    'JEV_PROVIDER=other',
    'CLOUDFLARE_ACCOUNT_ID=account',
    'CLOUDFLARE_API_TOKEN=token',
    'TYPESAFE_API_KEY=typesafe-token',
  ].join('\n'));
  assert.throws(() => loadConfig(path), { message: 'Unknown JEV_PROVIDER: other' });
});

test('requires only the selected provider credentials', async () => {
  const path = await temporaryEnvFile('JEV_PROVIDER=typesafe\n');
  assert.throws(() => loadConfig(path), { message: 'Missing required configuration: TYPESAFE_API_KEY' });
});

test('rejects a configuration file missing a required credential', async () => {
  const path = await temporaryEnvFile('CLOUDFLARE_ACCOUNT_ID=account\n');

  assert.throws(() => loadConfig(path), {
    message: 'Missing required configuration: CLOUDFLARE_API_TOKEN',
  });
});

test('rejects a missing configuration file without exposing secrets', () => {
  assert.throws(() => loadConfig('/does-not-exist/jev.env'), {
    message: 'Unable to read configuration file: /does-not-exist/jev.env',
  });
});
