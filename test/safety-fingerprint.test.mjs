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
  for (let i = 0; i < 64; i++) writeFileSync(join(root, 'app', `file${i}.txt`), i < 32 ? 'a'.repeat(32768) : '');
  const result = readRelatedCode(root, ['app']);
  assert.equal(result.status, 'complete');
  assert.equal(result.files.length, 64);
  assert.equal(result.files.reduce((total, file) => total + file.bytes, 0), 1048576);
  writeFileSync(join(root, 'app', 'file63.txt'), 'x');
  const over = readRelatedCode(root, ['app']);
  assert.equal(over.status, 'incomplete');
  assert.match(over.reason, /1024 KiB total limit/);
});

for (const [name, prepare, roots = ['app']] of [
  ['missing', () => {}, ['missing']],
  ['outside', () => {}, ['../outside']],
  ['symlink', (root) => symlinkSync('service.txt', join(root, 'app', 'link'))],
  ['parent symlink', (root) => symlinkSync('app', join(root, 'alias')), ['alias/service.txt']],
  ['binary', (root) => writeFileSync(join(root, 'app', 'binary'), Buffer.from([0, 1]))],
  ['non-UTF8', (root) => writeFileSync(join(root, 'app', 'invalid'), Buffer.from([0xff]))],
  ['large file', (root) => writeFileSync(join(root, 'app', 'large'), 'a'.repeat(32769))],
  ['total bytes', (root) => { for (let i = 0; i < 33; i++) writeFileSync(join(root, 'app', `large${i}`), 'a'.repeat(32768)); }],
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


test('composer.lock is digest-only for explicit paths and traversal, outside source file and byte limits', (t) => {
  const root = relatedProject(t);
  for (let i = 0; i < 64; i++) writeFileSync(join(root, 'app', `source${i}.php`), i < 32 ? 'a'.repeat(32768) : '');
  const lock = Buffer.from(JSON.stringify({ packages: [], marker: 'metadata-only'.repeat(100000) }));
  writeFileSync(join(root, 'app/composer.lock'), lock);
  const snapshot = readRelatedCode(root, ['app', 'app/composer.lock']);
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.files.length, 64);
  assert.deepEqual(snapshot.metadata, [{ key: 'app/composer.lock', bytes: lock.length, digest: sha256(lock) }]);
  assert.equal(JSON.stringify(snapshot).includes('metadata-only'), false);
  const explicit = readRelatedCode(root, ['app/composer.lock']);
  assert.equal(explicit.status, 'complete');
  assert.deepEqual(explicit.files, []);
  assert.deepEqual(explicit.metadata, snapshot.metadata);
  writeFileSync(join(root, 'app/composer.lock'), Buffer.concat([lock, Buffer.from('\r\n')]));
  assert.notEqual(readRelatedCode(root, ['app']).fingerprint, snapshot.fingerprint);
  writeFileSync(join(root, 'app/other.lock'), 'a'.repeat(32769));
  assert.equal(readRelatedCode(root, ['app/other.lock']).status, 'incomplete');
});

test('composer.lock metadata retains bounded reads and fail-closed path validation', (t) => {
  const root = relatedProject(t);
  const path = join(root, 'composer.lock');
  writeFileSync(path, Buffer.alloc(8 * 1024 * 1024));
  const exact = readRelatedCode(root, ['composer.lock']);
  assert.equal(exact.status, 'complete');
  assert.equal(exact.metadata[0].bytes, 8 * 1024 * 1024);
  writeFileSync(path, Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.match(readRelatedCode(root, ['composer.lock']).reason, /8 MiB/);
  rmSync(path);
  assert.equal(readRelatedCode(root, ['composer.lock']).status, 'incomplete');
  writeFileSync(join(root, 'app/lock.json'), '{}');
  symlinkSync(join(root, 'app/lock.json'), path);
  assert.match(readRelatedCode(root, ['composer.lock']).reason, /symbolic link/);
  rmSync(path);
  mkdirSync(path);
  writeFileSync(join(path, 'bad.php'), 'a'.repeat(32769));
  assert.equal(readRelatedCode(root, ['composer.lock']).status, 'incomplete', 'directories named composer.lock are still traversed');
});


test('metadata has its own file count bound', (t) => {
  const root = relatedProject(t);
  for (let i = 0; i < 64; i++) {
    mkdirSync(join(root, 'app', `dependency${i}`));
    writeFileSync(join(root, 'app', `dependency${i}`, 'composer.lock'), '{}');
  }
  const exact = readRelatedCode(root, ['app']);
  assert.equal(exact.status, 'complete');
  assert.equal(exact.metadata.length, 64);
  mkdirSync(join(root, 'app/extra'));
  writeFileSync(join(root, 'app/extra/composer.lock'), '{}');
  assert.match(readRelatedCode(root, ['app']).reason, /metadata.*64-file/);
});
