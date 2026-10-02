import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { evaluateTest } from '../../dist/test-checker.js';
import { openDatabase } from '../../dist/storage/sqlite.js';
import { transitionTestExecutionApproval } from '../../dist/storage/test-execution-approval.js';

// Run by laravel-fixture.mjs inside a fresh container with networking disabled.
const config = { provider: 'typesafe', apiKey: 'fixture-only-key', requestedModel: 'jev-1.13.0' };
globalThis.fetch = async (_url, init) => {
  const key = Object.keys(JSON.parse(init.body).questions)[0];
  return new Response(JSON.stringify({ model: config.requestedModel, answers: { [key]: { type: 'noul', noul: 0.1 } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
};
mkdirSync('bootstrap/cache', { recursive: true });
const cached = '<?php return ["fixture_cache_must_not_be_loaded" => true];\n';
writeFileSync('bootstrap/cache/config.php',cached);
const executionConditions = {
  target: {mode:'local'},
  entry: { adapter: 'composer-script', script: 'test' }, runner: { file: 'scripts/test-safe.php', safetyFiles: ['tests/Support/DatabaseGuard.php'] },
  selectors: { filePatterns: ['tests/Feature/**'], allowFilter: true, allowFullSuite: true },
  environmentFiles: ['phpunit.xml'], codeReviewRoots: ['tests/Support'],
  runtime: { php: '/usr/local/bin/php', composer: '/usr/local/bin/composer', composerHome: '/tmp/jev-composer-home', configFiles: [] },
  resources: { database: { policy: 'sqlite-memory', rejectFallback: true, rejectAdditionalConnections: true },
    filesystem: { writableRoots: ['bootstrap/cache'] }, network: { policy: 'deny' }, credentials: { policy: 'deny' } },
};
const input = { command: 'composer --no-plugins test', cwd: '/fixture', environment: 'testing', framework: 'laravel', executionConditions };
const pending = await evaluateTest(config,input);
assert.equal(pending.decision,'review',JSON.stringify(pending)); assert.ok(pending.executionReviewId,JSON.stringify(pending));
transitionTestExecutionApproval(openDatabase(),pending.executionReviewId,'approve',new Date().toISOString());
const repeat = {command:input.command,cwd:input.cwd,framework:input.framework,environment:input.environment};
const allowed = await evaluateTest(config,repeat);
assert.equal(allowed.decision,'allow',JSON.stringify(allowed)); assert.equal(allowed.executionAssessment.ticket,undefined);
const run = () => {
  const child=spawnSync('/usr/local/bin/composer',['--no-plugins','test'],{encoding:'utf8',env:{...process.env,DB_CONNECTION:'mysql',DB_DATABASE:'unapproved_probe'}});
  assert.equal(child.status,0,child.stdout+child.stderr);
  assert.match(child.stdout,/OK \(3 tests, 4 assertions\)/u);
  assert.equal(readFileSync('bootstrap/cache/config.php','utf8'),cached,'runner restores prior configuration cache');
  assert.equal(spawnSync('/usr/local/bin/php',['-r','exit(file_exists("/tmp/jev-disposable-probe.sqlite") ? 1 : 0);']).status,0,'rejected persistent target was never opened');
  return child.stdout;
};
process.stdout.write(run());
const again = await evaluateTest(config,repeat);
assert.equal(again.decision,'allow');assert.equal(again.executionApproval.approvalId,pending.executionReviewId);assert.equal(again.codeAssessment.status,'cache-hit');
run();
const bypass=spawnSync('/usr/local/bin/php',['vendor/bin/phpunit'],{encoding:'utf8'});
assert.notEqual(bypass.status,0,'the fixture cannot execute safely without its runner');
assert.match(bypass.stdout+bypass.stderr,/Runner failed to enforce/u);
console.log('Gate + existing runner: approval reused; Ticket absent; actual SQLite memory verified; persistent/fallback targets rejected; cache restored; direct bypass rejected.');
