import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, testInputIdentity } from '../dist/safety-fingerprint.js';

test('raw text identities distinguish omitted, empty, line endings and Unicode representations', () => {
  const base = { command: 'npm test' };
  const identity = (text) => canonicalJson(testInputIdentity({ ...base, testCode: text }));
  for (const [first, second] of [[undefined, ''], ['a\nb', 'a\r\nb'], ['é', 'e\u0301'], ['\\r\\n', '\\n']]) {
    assert.notEqual(identity(first), identity(second));
  }
  assert.equal(identity('unchanged'), identity('unchanged'));
});

test('input identity contains digests rather than raw field contents', () => {
  const text = 'raw-fingerprint-fixture-8374';
  const identity = canonicalJson(testInputIdentity({ command: text, testCode: text, diff: text, context: text, framework: text, environment: text }));
  assert.equal(identity.includes(text), false);
  assert.ok(identity.includes('sha256:'));
});

test('Profile v2 keeps command and environment outside the code identity', () => {
  const base = { command: 'bin/runner', environment: 'testing', testCode: 'const secret = "a";' };
  assert.equal(canonicalJson(testInputIdentity(base, undefined, true)), canonicalJson(testInputIdentity({ ...base, command: 'bin/other', environment: 'other' }, undefined, true)));
  assert.notEqual(canonicalJson(testInputIdentity(base, undefined, true)), canonicalJson(testInputIdentity({ ...base, testCode: 'const secret = "b";' }, undefined, true)));
});
