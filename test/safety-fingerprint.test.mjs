import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, readRelatedCode, sha256, testInputIdentity } from '../dist/safety-fingerprint.js';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function relatedProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'jev-related-snapshot-'));
  mkdirSync(join(root, 'app'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('related snapshots deduplicate overlapping roots and identify raw contents, additions and deletions', (t) => {
  const root = relatedProject(t);
  const path = join(root, 'app', 'service.txt');
  const original = Buffer.from('\ufeffé\r\n');
  writeFileSync(path, original);
  const first = readRelatedCode(root, ['app/service.txt', 'app', 'app']);
  assert.equal(first.status, 'complete');
  assert.equal(first.files.length, 1);
  assert.equal(first.files[0].content, original.toString('utf8'));
  assert.equal(first.files[0].digest, sha256(original));
  assert.equal(first.fingerprint, readRelatedCode(root, ['app']).fingerprint);
  writeFileSync(path, 'e\u0301\n');
  assert.notEqual(first.fingerprint, readRelatedCode(root, ['app']).fingerprint);
  const changed = readRelatedCode(root, ['app']);
  writeFileSync(join(root, 'app', 'added.txt'), 'safe');
  assert.notEqual(changed.fingerprint, readRelatedCode(root, ['app']).fingerprint);
  rmSync(join(root, 'app', 'added.txt'));
  assert.equal(changed.fingerprint, readRelatedCode(root, ['app']).fingerprint);
  assert.equal(readRelatedCode(root, []).status, 'complete');
});

test('related snapshot accepts exactly the file and byte limits', (t) => {
  const root = relatedProject(t);
  for (let i = 0; i < 64; i++) writeFileSync(join(root, 'app', `file${i}.txt`), i < 2 ? 'a'.repeat(32768) : '');
  const result = readRelatedCode(root, ['app']);
  assert.equal(result.status, 'complete');
  assert.equal(result.files.length, 64);
  assert.equal(result.files.reduce((total, file) => total + file.bytes, 0), 65536);
});

for (const [name, prepare, roots = ['app']] of [
  ['missing', () => {}, ['missing']],
  ['outside', () => {}, ['../outside']],
  ['symlink', (root) => symlinkSync('service.txt', join(root, 'app', 'link'))],
  ['parent symlink', (root) => symlinkSync('app', join(root, 'alias')), ['alias/service.txt']],
  ['binary', (root) => writeFileSync(join(root, 'app', 'binary'), Buffer.from([0, 1]))],
  ['non-UTF8', (root) => writeFileSync(join(root, 'app', 'invalid'), Buffer.from([0xff]))],
  ['large file', (root) => writeFileSync(join(root, 'app', 'large'), 'a'.repeat(32769))],
  ['total bytes', (root) => { for (let i = 0; i < 3; i++) writeFileSync(join(root, 'app', `large${i}`), 'a'.repeat(32768)); }],
  ['file count', (root) => { for (let i = 0; i < 65; i++) writeFileSync(join(root, 'app', `${i}`), ''); }],
  ['entry count', (root) => { for (let i = 0; i < 4097; i++) mkdirSync(join(root, 'app', `${i}`)); }],
]) {
  test(`related snapshot fails closed for ${name}`, (t) => {
    const root = relatedProject(t);
    writeFileSync(join(root, 'app', 'service.txt'), 'safe');
    prepare(root);
    const result = readRelatedCode(root, roots);
    assert.equal(result.status, 'incomplete');
    assert.equal(result.fingerprint, undefined);
    assert.equal(result.reason.includes(root), false);
  });
}

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
