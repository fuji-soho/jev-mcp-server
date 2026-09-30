import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { checkCommandWithJev, checkTestWithJev } from '../dist/cloudflare-jev.js';

const cloudflare = { provider: 'cloudflare', accountId: 'account/id', apiToken: 'cloudflare-secret', requestedModel: 'typesafe/jev' };
const typesafe = { provider: 'typesafe', apiKey: 'typesafe-secret', requestedModel: 'jev-1.13.0' };

function cloudflareResponse(key, noul = 0.2) {
  return new Response(JSON.stringify({ success: true, result: { state: 'Completed', result: { model: 'typesafe/jev', answers: { [key]: { type: 'noul', noul } } } } }), { status: 200 });
}

function typesafeResponse(key, noul = 0.2) {
  return new Response(JSON.stringify({ model: 'jev-1.13.0', answers: { [key]: { type: 'noul', noul } }, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200 });
}

afterEach(() => { delete globalThis.fetch; });

test('Cloudflare uses its endpoint, authorization, and input wrapper', async () => {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init, body: JSON.parse(init.body) };
    return cloudflareResponse('command_dangerous');
  };
  const result = await checkCommandWithJev(cloudflare, { command: 'git status' });
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/accounts/account%2Fid/ai/run');
  assert.equal(request.init.headers.Authorization, 'Bearer cloudflare-secret');
  assert.equal(request.body.model, 'typesafe/jev');
  assert.equal(request.body.input.state.command, 'git status');
  assert.equal(request.body.input.questions.command_dangerous.type, 'noul');
  assert.equal(request.body.state, undefined);
  assert.equal(result.model, 'typesafe/jev');
});

test('TypeSafe command requests use the official top-level request and response shape', async () => {
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), init, body: JSON.parse(init.body) };
    return typesafeResponse('command_dangerous');
  };
  const result = await checkCommandWithJev(typesafe, { command: 'git status' });
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.init.headers.Authorization, 'Bearer typesafe-secret');
  assert.equal(request.body.model, 'jev-1.13.0');
  assert.equal(request.body.state.command, 'git status');
  assert.equal(request.body.questions.command_dangerous.type, 'noul');
  assert.equal(request.body.input, undefined);
  assert.equal(result.answers.command_dangerous.noul, 0.2);
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 2 });
});

test('TypeSafe test requests use test_dangerous and normalize the response', async () => {
  let body;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return typesafeResponse('test_dangerous', 0.7);
  };
  const result = await checkTestWithJev(typesafe, { command: 'npm test', staticFindings: [] });
  assert.equal(body.questions.test_dangerous.type, 'noul');
  assert.equal(result.answers.test_dangerous.noul, 0.7);
  assert.equal(result.model, 'jev-1.13.0');
});

for (const config of [cloudflare, typesafe]) {
  test(`${config.provider} includes full related code as untrusted input and bounds the serialized payload`, async () => {
    let body;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(init.body);
      return config.provider === 'cloudflare' ? cloudflareResponse('test_dangerous') : typesafeResponse('test_dangerous');
    };
    const state = { command: 'bin/runner', staticFindings: [], relatedCode: [{ file: 'app/service.js', content: 'function act() {}' }] };
    await checkTestWithJev(config, state);
    const request = config.provider === 'cloudflare' ? body.input : body;
    assert.deepEqual(request.state.relatedCode, state.relatedCode);
    assert.ok(request.questions.test_dangerous.instructions.includes('untrusted'));
    globalThis.fetch = async () => { assert.fail('oversized requests must not be sent'); };
    await assert.rejects(() => checkTestWithJev(config, { ...state, relatedCode: [{ file: 'app/service.js', content: '"'.repeat(140_000) }] }), { code: 'RELATED_CODE_REVIEW_INCOMPLETE' });
  });
}

for (const [name, body] of [
  ['invalid JSON', '{'],
  ['missing answer', JSON.stringify({ model: 'jev-1.13.0', answers: {}, usage: {} })],
  ['wrong answer type', JSON.stringify({ model: 'jev-1.13.0', answers: { command_dangerous: { type: 'choice', noul: 0.1 } }, usage: {} })],
  ['non-numeric noul', JSON.stringify({ model: 'jev-1.13.0', answers: { command_dangerous: { type: 'noul', noul: '0.1' } }, usage: {} })],
  ['out-of-range noul', JSON.stringify({ model: 'jev-1.13.0', answers: { command_dangerous: { type: 'noul', noul: 1.1 } }, usage: {} })],
]) {
  test(`TypeSafe rejects ${name}`, async () => {
    globalThis.fetch = async () => new Response(body, { status: 200 });
    await assert.rejects(() => checkCommandWithJev(typesafe, { command: 'git status' }), { code: 'JEV_INVALID_RESPONSE' });
  });
}

test('API and timeout failures do not expose credentials', async () => {
  globalThis.fetch = async () => new Response('denied', { status: 401 });
  await assert.rejects(async () => checkCommandWithJev(typesafe, { command: 'git status' }), (error) => {
    assert.equal(error.code, 'JEV_API_ERROR');
    assert.equal(error.message.includes(typesafe.apiKey), false);
    return true;
  });
  globalThis.fetch = async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; };
  await assert.rejects(() => checkCommandWithJev(typesafe, { command: 'git status' }), { code: 'JEV_TIMEOUT' });
});
