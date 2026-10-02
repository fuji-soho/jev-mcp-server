import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { evaluateTest } from '../dist/test-checker.js';
import { resolveComposerHome, snapshotExecution } from '../dist/execution-profile.js';
import { openDatabase, resetDatabaseForTests } from '../dist/storage/sqlite.js';
import { executionApprovalFor, getTestExecutionApproval, transitionTestExecutionApproval } from '../dist/storage/test-execution-approval.js';
import { transitionHumanReview } from '../dist/storage/human-review.js';

const config = { provider: 'typesafe', apiKey: 'mock-key', requestedModel: 'jev-1.13.0' };
const originalFetch = globalThis.fetch;
const dirs = [];
afterEach(() => { globalThis.fetch = originalFetch; resetDatabaseForTests(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const cwd = mkdtempSync('/tmp/jev-execution-'); dirs.push(cwd);
  for (const path of ['.jev','scripts','tests/Feature','tests/Support','app','config','vendor/bin','vendor/composer','runtime']) mkdirSync(join(cwd,path), { recursive: true });
  const put = (file, value) => writeFileSync(join(cwd,file), value);
  put('runtime/php', '#!/bin/sh\nexit 1\n'); put('runtime/composer', `#!${join(cwd,'runtime/php')}\n<?php /* mock executable; never run */\n`);
  chmodSync(join(cwd,'runtime/php'), 0o700); chmodSync(join(cwd,'runtime/composer'), 0o700);
  put('composer.json', JSON.stringify({ scripts: { test: '@safe-test', 'safe-test': '@php scripts/test-safe.php' } }));
  put('composer.lock', '{"packages":[]}'); put('vendor/composer/installed.json', '{"packages":[]}');
  put('scripts/test-safe.php', '<?php require "tests/Support/DatabaseGuard.php"; $command = [PHP_BINARY, "vendor/bin/phpunit"]; /* reviewed runtime boundary */\n');
  put('tests/Support/DatabaseGuard.php', '<?php function assertMemory() {}\n');
  put('vendor/bin/phpunit', '<?php /* PHPunit launcher */\n');
  put('phpunit.xml', '<phpunit><testsuites><testsuite name="Feature"><directory>tests/Feature</directory></testsuite></testsuites></phpunit>');
  put('config/database.php', '<?php return ["default"=>"sqlite"];\n');
  put('app/Service.php', '<?php class Service {}\n');
  put('tests/Feature/FirstTest.php', '<?php class FirstTest { public function testOne() {} }\n');
  const profile = { version: 3, name: 'safe-tests', framework: 'laravel', environment: 'testing',
    entry: { adapter: 'composer-script', script: 'test' }, runner: { file: 'scripts/test-safe.php', safetyFiles: ['tests/Support/DatabaseGuard.php'] },
    selectors: { filePatterns: ['tests/Feature/**'], allowFilter: true, allowFullSuite: true },
    environmentFiles: ['phpunit.xml','config/database.php'], codeReviewRoots: ['app','tests/Support'],
    runtime: { php: join(cwd,'runtime/php'), composer: join(cwd,'runtime/composer'), composerHome: resolveComposerHome(), configFiles: [] },
    resources: { database: { policy: 'sqlite-memory', rejectFallback: true, rejectAdditionalConnections: true }, filesystem: { writableRoots: [] }, network: { policy: 'deny' }, credentials: { policy: 'deny' } } };
  const save = () => put('.jev/test-safety.json', JSON.stringify(profile)); save();
  const input = { command: `${profile.runtime.composer} test`, safetyProfilePath:join(cwd,'.jev/test-safety.json'), cwd, framework: 'laravel', environment: 'testing' };
  return { cwd, put, profile, save, input };
}
function mock(commandScore = 0.1, codeScore = 0.1, model = config.requestedModel) {
  const calls = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body), key = Object.keys(body.questions)[0]; calls.push(body);
    return new Response(JSON.stringify({ model, answers: { [key]: { type: 'noul', noul: key === 'command_dangerous' ? commandScore : codeScore } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
  };
  return calls;
}
async function approve(f) {
  const pending = await evaluateTest(config, f.input);
  assert.equal(pending.executionApproval?.status, 'pending', JSON.stringify(pending));
  transitionTestExecutionApproval(openDatabase(), pending.executionReviewId, 'approve', new Date().toISOString());
  return pending.executionReviewId;
}

test('one test gate, continuing approval, full-suite additions and code-only changes without tickets', async () => {
  const f = fixture(), calls = mock(); const id = await approve(f);
  assert.equal(calls.length, 0);
  const first = await evaluateTest(config,f.input);
  assert.equal(first.decision,'allow',JSON.stringify(first)); assert.equal(first.executionAssessment.ticket,undefined);
  assert.deepEqual(calls.map(c=>Object.keys(c.questions)[0]),['command_dangerous','test_dangerous']);
  const again = await evaluateTest(config,f.input);
  assert.equal(again.codeAssessment.status,'cache-hit'); assert.equal(calls.length,3,'command is always freshly evaluated');
  f.put('tests/Feature/SecondTest.php','<?php class SecondTest {}\n');
  const added = await evaluateTest(config,f.input);
  assert.equal(added.decision,'allow'); assert.equal(added.executionApproval.approvalId,id);
  assert.equal(calls.length,5,'existing file code cache reused; new file reviewed');
  f.put('app/Service.php','<?php class Service { public function changed() {} }\n');
  const related = await evaluateTest(config,f.input);
  assert.equal(related.decision,'allow'); assert.equal(related.executionApproval.approvalId,id); assert.equal(calls.length,8);
  const record = getTestExecutionApproval(openDatabase(),id);
  assert.equal(record.expiresAt,undefined);
  const old = openDatabase().prepare('SELECT expires_at FROM test_execution_approvals WHERE approval_id=?').get(id);
  assert.equal(old.expires_at,null);
  assert.equal(executionApprovalFor(openDatabase(),snapshotExecution(f.input),'2099-01-01T00:00:00.000Z').approvalId,id,'no periodic reapproval');
});

test('permitted filter changes preserve code cache but exact execution review identity changes', async () => {
  const f=fixture(), calls=mock(); const id=await approve(f);
  await evaluateTest(config,f.input);
  const filtered=await evaluateTest(config,{...f.input,command:`${f.input.command} -- --filter FirstTest`});
  assert.equal(filtered.decision,'allow'); assert.equal(filtered.executionApproval.approvalId,id); assert.equal(filtered.codeAssessment.status,'cache-hit'); assert.equal(calls.length,3);
});

for (const file of ['composer.json','scripts/test-safe.php','tests/Support/DatabaseGuard.php','config/database.php','vendor/bin/phpunit']) {
  test(`${file} changes require execution reapproval and cannot resurrect superseded approvals`,async()=>{
    const f=fixture();mock();const id=await approve(f);const old=readFileSync(join(f.cwd,file),'utf8');
    f.put(file,file.endsWith('.json')?old.replace('"test":','"unused":"@safe-test","test":'):old+'\n');
    const changed=await evaluateTest(config,f.input);assert.equal(changed.decision,'review');assert.notEqual(changed.executionReviewId,id);
    assert.equal(getTestExecutionApproval(openDatabase(),id).status,'superseded');
    f.put(file,old);const reverted=await evaluateTest(config,f.input);assert.equal(reverted.decision,'review');assert.notEqual(reverted.executionReviewId,id);
  });
}

test('approval rereads evidence, pending expires, approved has no periodic deadline, revoke/reject never reactivate an ID',async()=>{
  const f=fixture();mock();let pending=await evaluateTest(config,f.input);
  f.put('scripts/test-safe.php',readFileSync(join(f.cwd,'scripts/test-safe.php'),'utf8')+'\n');
  assert.throws(()=>transitionTestExecutionApproval(openDatabase(),pending.executionReviewId,'approve',new Date().toISOString()),/changed/u);
  pending=await evaluateTest(config,f.input);
  assert.throws(()=>transitionTestExecutionApproval(openDatabase(),pending.executionReviewId,'approve','2099-01-01T00:00:00.000Z'),/expired/u);
  const id=await approve(f);transitionTestExecutionApproval(openDatabase(),id,'revoke',new Date().toISOString());
  const blocked=await evaluateTest(config,f.input);assert.equal(blocked.allowed,false);assert.notEqual(blocked.executionReviewId,id);
  transitionTestExecutionApproval(openDatabase(),blocked.executionReviewId,'reject',new Date().toISOString());
  assert.throws(()=>transitionTestExecutionApproval(openDatabase(),blocked.executionReviewId,'approve',new Date().toISOString()),/not pending/u);
});

test('exact approval cannot cross projects or selection scope, and full-suite subsets cannot be reviewed',async()=>{
  const f=fixture();mock();const id=await approve(f);const other=fixture();
  const crossed=await evaluateTest(config,{...other.input,executionApprovalId:id});assert.equal(crossed.errorCode,'EXECUTION_APPROVAL_MISMATCH');
  f.put('tests/Feature/SecondTest.php','<?php class SecondTest {}');
  const partial=await evaluateTest(config,{...f.input,testFiles:['tests/Feature/FirstTest.php']});assert.equal(partial.errorCode,'EXECUTION_TARGET_MISMATCH');assert.equal(partial.executionReviewId,undefined);
  for(const suffix of [' -- --configuration other.xml',' -- --bootstrap custom.php',' -- ../outside.php',' -- --filter FirstTest --filter SecondTest']) {
    const result=await evaluateTest(config,{...f.input,command:f.input.command+suffix});assert.equal(result.allowed,false);assert.equal(result.reviewId,undefined);assert.equal(result.executionReviewId,undefined);
  }
});

test('missing files, symlinks, invalid XML, unsupported handlers, plugins and compound commands are unapprovable',async()=>{
  const f=fixture(),calls=mock();
  const original=readFileSync(join(f.cwd,'composer.json'),'utf8');
  for(const script of ['@cycle','SomeClass::run','@php scripts/test-safe.php && rm -rf /','@composer install']){
    f.put('composer.json',JSON.stringify({scripts:{test:script,cycle:'@test'}}));
    const result=await evaluateTest(config,f.input);assert.equal(result.allowed,false);assert.equal(result.executionReviewId,undefined);
  }
  f.put('composer.json',original);
  f.put('phpunit.xml','<phpunit><testsuites></phpunit>');
  assert.equal((await evaluateTest(config,f.input)).errorCode,'EXECUTION_TARGET_UNRESOLVED');
  f.put('phpunit.xml','<phpunit><testsuites><testsuite><directory>tests/Feature</directory></testsuite></testsuites></phpunit>');
  f.put('vendor/composer/installed.json','{"packages":[{"type":"composer-plugin"}]}');
  assert.equal((await evaluateTest(config,f.input)).errorCode,'EXECUTION_PLUGINS_UNSUPPORTED');
  const pluginDisabled=await evaluateTest(config,{...f.input,command:`${f.profile.runtime.composer} --no-plugins test`});assert.ok(pluginDisabled.executionReviewId);
  f.put('vendor/composer/installed.json','{"packages":[]}');
  rmSync(join(f.cwd,'scripts/test-safe.php'));
  symlinkSync(join(f.cwd,'app/Service.php'),join(f.cwd,'scripts/test-safe.php'));
  const symlink=await evaluateTest(config,f.input);assert.equal(symlink.executionReviewId,undefined);assert.equal(symlink.allowed,false);
  const compound=await evaluateTest(config,{...f.input,command:f.input.command+' && rm -rf /'});assert.equal(compound.decision,'deny');
  assert.equal(calls.length,0);
});

test('command-only policy deny and code deny cannot be overridden; API failure cannot use code cache',async()=>{
  const f=fixture();mock();const id=await approve(f);await evaluateTest(config,f.input);
  globalThis.fetch=async()=>{throw Error('network');};
  const failure=await evaluateTest(config,f.input);assert.equal(failure.errorCode,'JEV_NETWORK_ERROR');assert.equal(failure.allowed,false);assert.equal(failure.reviewId,undefined);
  f.put('tests/Feature/FirstTest.php','<?php DB::statement("DROP DATABASE dangerous_fixture");');
  const denied=await evaluateTest(config,f.input);assert.equal(denied.decision,'deny');assert.equal(denied.reviewId,undefined);
  f.put('tests/Feature/FirstTest.php','<?php class FirstTest {}');
  f.put('.jev-policy.json',JSON.stringify({version:1,rules:[{name:'block-composer',match:{type:'contains',value:'test'},decision:'deny',reason:'Project command prohibition.'}]}));
  assert.equal((await evaluateTest(config,f.input)).decision,'deny');
  assert.equal(getTestExecutionApproval(openDatabase(),id).status,'approved','blocked code does not silently revoke independent approval');
});

test('separate command and code Human Reviews remain model-bound and never populate automatic allow cache',async()=>{
  const f=fixture();mock();const id=await approve(f);mock(0.5,0.5);
  const pending=await evaluateTest(config,f.input);
  assert.equal(pending.decision,'review');assert.deepEqual(pending.reviewReasons.map(r=>r.kind).sort(),['code-risk','command-risk']);
  assert.equal(pending.reviewIds.length,2);
  for(const reviewId of pending.reviewIds)transitionHumanReview(openDatabase(),reviewId,'approve',new Date().toISOString());
  const approved=await evaluateTest(config,f.input);assert.equal(approved.decision,'allow',JSON.stringify(approved));
  assert.equal(openDatabase().prepare('SELECT count(*) AS n FROM fingerprint_cache WHERE reusable=1').get().n,0);
  mock(0.5,0.5,'jev-1.14.0');const changed=await evaluateTest(config,f.input);assert.equal(changed.decision,'review');assert.equal(changed.executionApproval.approvalId,id);
  mock(0.9,0.1);assert.equal((await evaluateTest(config,f.input)).decision,'deny');
});

test('raw secret changes invalidate appropriate identities without persisting or transmitting values',async()=>{
  const f=fixture(),calls=mock();await approve(f);
  const alpha='fixture-alpha-secret-184',beta='fixture-beta-secret-271';
  f.put('tests/Feature/FirstTest.php',`<?php $password = "${alpha}";`);await evaluateTest(config,f.input);
  f.put('tests/Feature/FirstTest.php',`<?php $password = "${beta}";`);const changed=await evaluateTest(config,f.input);assert.equal(changed.codeAssessment.status,'evaluated');
  for(const secret of [alpha,beta]){
    assert.equal(JSON.stringify(calls).includes(secret),false);
    for(const table of ['test_execution_approvals','human_reviews','fingerprint_cache','audit_log'])assert.equal(JSON.stringify(openDatabase().prepare(`SELECT * FROM ${table}`).all()).includes(secret),false);
  }
});

test('all code shares the pre-API snapshot and a fixed-model mismatch cannot enter code cache',async()=>{
  const f=fixture();mock();await approve(f);
  const calls=mock();const fetch=globalThis.fetch;
  globalThis.fetch=async(...args)=>{const result=await fetch(...args);f.put('tests/Feature/FirstTest.php','<?php class ChangedAfterSnapshot {}');return result;};
  assert.equal((await evaluateTest(config,f.input)).decision,'allow');
  assert.equal(calls[1].state.testCode.includes('ChangedAfterSnapshot'),false);
  mock(0.1,0.1,'jev-1.14.0');const mismatch=await evaluateTest(config,f.input);
  assert.equal(openDatabase().prepare('SELECT count(*) AS n FROM fingerprint_cache WHERE fingerprint=? AND reusable=1').get(mismatch.codeAssessment.fingerprint).n,0);
  const snapshot=snapshotExecution(f.input);assert.ok(snapshot.files.length);
});

test('removing/downgrading v3 configuration cannot fall back to caller-declared isolation',async()=>{
  const f=fixture();mock();await approve(f);await evaluateTest(config,f.input);
  for(const content of [undefined,'{"version":1,"name":"legacy","safetyFiles":["phpunit.xml"]}']){
    if(content===undefined)rmSync(join(f.cwd,'.jev/test-safety.json'));else f.put('.jev/test-safety.json',content);
    const result=await evaluateTest(config,{...f.input,command:'node --test tests/check.js',isolation:{ephemeralDatabase:true},runtime:{productionAccess:false,persistentStorageAccess:false}});
    assert.equal(result.allowed,false);assert.equal(result.reviewId,undefined);assert.equal(result.executionReviewId,undefined);
  }
});

test('environment settings and policy changes invalidate execution approval; provider changes do not',async()=>{
  const f=fixture();mock();const id=await approve(f);
  const different=await evaluateTest({...config,requestedModel:'jev-latest'},f.input);assert.equal(different.executionApproval.approvalId,id);
  f.put('.env.testing','DB_PASSWORD=fixture-environment-secret-a\n');
  const environment=await evaluateTest(config,f.input);assert.equal(environment.allowed,false);assert.notEqual(environment.executionReviewId,id);
  transitionTestExecutionApproval(openDatabase(),environment.executionReviewId,'approve',new Date().toISOString());
  f.put('.env.testing','DB_PASSWORD=fixture-environment-secret-b\n');
  const masked=await evaluateTest(config,f.input);assert.notEqual(masked.executionReviewId,environment.executionReviewId);
  f.put('.jev-policy.json',JSON.stringify({version:1,rules:[]}));
  assert.notEqual((await evaluateTest(config,f.input)).executionReviewId,masked.executionReviewId);
});

test('runner and related secrets are masked before JSON serialization for command and code requests',async()=>{
  const f=fixture();const secret='fixture-runner-secret-6431';
  f.put('scripts/test-safe.php',readFileSync(join(f.cwd,'scripts/test-safe.php'),'utf8')+`\n$password = "${secret}";\n`);
  const calls=mock();await approve(f);assert.equal((await evaluateTest(config,f.input)).decision,'allow');
  assert.equal(JSON.stringify(calls).includes(secret),false);
  assert.equal(JSON.stringify(openDatabase().prepare('SELECT * FROM test_execution_approvals').all()).includes(secret),false);
});

test('MCP exposes v3 reasons and exact-ID approval/revocation with schema-valid results',async()=>{
  const f=fixture();
  f.put('runtime/jev.env','JEV_PROVIDER=typesafe\nTYPESAFE_API_KEY=mock-key\nTYPESAFE_MODEL=jev-1.13.0\n');
  f.put('runtime/mock-fetch.mjs',`globalThis.fetch = async (_url,init) => {const key=Object.keys(JSON.parse(init.body).questions)[0];return new Response(JSON.stringify({model:'jev-1.13.0',answers:{[key]:{type:'noul',noul:0.1}},usage:{input_tokens:1,output_tokens:1}}),{status:200});};`);
  const environment={...process.env,JEV_ENV_PATH:join(f.cwd,'runtime/jev.env'),JEV_CACHE_DB_PATH:':memory:'};
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(join(f.cwd,'runtime/mock-fetch.mjs')).href,join(process.cwd(),'dist/index.js')],env:environment,stderr:'pipe'});
  const client=new Client({name:'execution-profile-test',version:'1.0.0'});
  try{
    await client.connect(transport);
    const pending=await client.callTool({name:'jev_check_test',arguments:f.input});
    assert.equal(pending.isError??false,false);assert.equal(pending.structuredContent.reviewReasons[0].kind,'execution-approval');
    const approvalId=pending.structuredContent.executionReviewId;
    const approved=await client.callTool({name:'jev_execution_approve',arguments:{approvalId}});assert.equal(approved.structuredContent.ok,true);
    const allowed=await client.callTool({name:'jev_check_test',arguments:{...f.input,executionApprovalId:approvalId}});
    assert.equal(allowed.structuredContent.allowed,true);assert.equal(allowed.structuredContent.safetyProfile.version,3);assert.equal(allowed.structuredContent.executionAssessment.ticket,undefined);
    assert.equal((await client.callTool({name:'jev_execution_revoke',arguments:{approvalId}})).structuredContent.status,'revoked');
    const revoked=await client.callTool({name:'jev_check_test',arguments:{...f.input,executionApprovalId:approvalId}});assert.equal(revoked.structuredContent.allowed,false);
  }finally{await client.close();}
});

test('direct PHP runner, quoted literal filters, and unquoted expansion boundaries',async()=>{
  const f=fixture();f.profile.entry={adapter:'php-runner'};f.save();f.input.command=`${f.profile.runtime.php} scripts/test-safe.php`;mock();await approve(f);
  const literal=await evaluateTest(config,{...f.input,command:f.input.command+' --filter "FirstTest::test.*"'});assert.equal(literal.allowed,true);
  for(const filter of ['*','FirstTest[ab]','{one,two}','--configuration']){
    const result=await evaluateTest(config,{...f.input,command:f.input.command+' --filter '+filter});assert.equal(result.allowed,false);assert.equal(result.reviewId,undefined);
  }
});

test('a requested approval ID cannot resurrect an environment changed and then restored',async()=>{
  const f=fixture();mock();const id=await approve(f);const prior=readFileSync(join(f.cwd,'config/database.php'),'utf8');
  f.put('config/database.php',prior+'\n');
  const changed=await evaluateTest(config,{...f.input,executionApprovalId:id});assert.equal(changed.errorCode,'EXECUTION_APPROVAL_MISMATCH');
  assert.equal(getTestExecutionApproval(openDatabase(),id).status,'superseded');
  f.put('config/database.php',prior);assert.equal((await evaluateTest(config,{...f.input,executionApprovalId:id})).allowed,false);
});
