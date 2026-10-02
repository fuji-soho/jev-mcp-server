import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { evaluateTest } from '../dist/test-checker.js';
import { openDatabase, resetDatabaseForTests } from '../dist/storage/sqlite.js';
import { transitionTestExecutionApproval, getTestExecutionApproval } from '../dist/storage/test-execution-approval.js';
import { transitionHumanReview } from '../dist/storage/human-review.js';
import { resolveComposerHome } from '../dist/execution-profile.js';

const config={provider:'typesafe',apiKey:'fixture-key',requestedModel:'jev-1.13.0'};
const originalFetch=globalThis.fetch, dirs=[];
afterEach(()=>{globalThis.fetch=originalFetch;resetDatabaseForTests();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(mode='podman') {
  const cwd=mkdtempSync('/tmp/jev-conditions-');dirs.push(cwd);
  for(const directory of ['scripts','tests/Feature','tests/Support','app','config','runtime'])mkdirSync(join(cwd,directory),{recursive:true});
  const put=(file,content)=>writeFileSync(join(cwd,file),content);
  put('composer.json',JSON.stringify({scripts:{test:'@safe',safe:'@php scripts/test-safe.php'}}));
  put('composer.lock','{"packages":[]}');
  put('scripts/test-safe.php','<?php require "tests/Support/DatabaseGuard.php"; $entry=[PHP_BINARY,"vendor/bin/phpunit"];\n');
  put('tests/Support/DatabaseGuard.php','<?php function guardMemory() {}\n');
  put('tests/Feature/FirstTest.php','<?php class FirstTest {}\n');
  put('phpunit.xml','<phpunit bootstrap="tests/bootstrap.php"><testsuites><testsuite name="Feature"><directory>tests/Feature</directory></testsuite></testsuites></phpunit>');
  put('tests/bootstrap.php','<?php require "tests/Support/DatabaseGuard.php";\n');
  put('app/Service.php','<?php class Service {}\n');
  const executionConditions={
    target: mode==='local'?{mode}:{mode,containerName:'fixture',projectRoot:'/container/project',cwd:'/container/project'},
    runner:{safetyFiles:['tests/Support/DatabaseGuard.php']},
    selectors:{filePatterns:['tests/Feature/**'],allowFilter:true,allowFullSuite:true},
    codeReviewRoots:['app','tests/Support'],
    resources:{database:{policy:'sqlite-memory',rejectFallback:true,rejectAdditionalConnections:true},filesystem:{writableRoots:[]},network:{policy:'deny'},credentials:{policy:'deny'}},
  };
  let command=`${mode} exec fixture sh -lc 'cd /container/project && composer test'`;
  if(mode==='local') {
    for(const directory of ['vendor/bin','vendor/composer'])mkdirSync(join(cwd,directory),{recursive:true});
    put('vendor/composer/installed.json','{"packages":[]}');put('vendor/bin/phpunit','<?php /* launcher */\n');
    put('runtime/php','#!/bin/sh\nexit 1\n');put('runtime/composer',`#!${join(cwd,'runtime/php')}\n<?php /* inspectable executable */\n`);
    for(const name of ['php','composer'])chmodSync(join(cwd,'runtime',name),0o700);
    executionConditions.runtime={php:join(cwd,'runtime/php'),composer:join(cwd,'runtime/composer'),composerHome:resolveComposerHome(),configFiles:[]};
    command=`${executionConditions.runtime.composer} test`;
  }
  const input={cwd,command,framework:'laravel',environment:'testing',executionConditions};
  const repeat={cwd,command,framework:'laravel',environment:'testing'};
  return {cwd,put,input,repeat,executionConditions};
}
function mock(command=0.1,code=0.1,model=config.requestedModel) {
  const calls=[];globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(init.body),key=Object.keys(body.questions)[0];calls.push(body);
    return new Response(JSON.stringify({model,answers:{[key]:{type:'noul',noul:key==='command_dangerous'?command:code}},usage:{input_tokens:1,output_tokens:1}}),{status:200});
  };return calls;
}
async function approve(input) {
  const pending=await evaluateTest(config,input);
  assert.ok(pending.executionReviewId,JSON.stringify(pending));assert.ok(pending.executionConditionsId);
  transitionTestExecutionApproval(openDatabase(),pending.executionReviewId,'approve',new Date().toISOString());return pending;
}

test('no Profile: initial missing fields are actionable, and partial conditions infer entry, runner and XML',async()=>{
  const f=fixture();const calls=mock();
  const missing=await evaluateTest(config,f.repeat);
  assert.equal(missing.allowed,false);assert.equal(missing.needsHumanReview,false);assert.equal(missing.reviewId,undefined);assert.equal(missing.executionReviewId,undefined);
  assert.equal(missing.errorCode,'EXECUTION_REGISTRATION_INCOMPLETE');
  assert.ok(missing.missingFields.some(x=>x.field==='executionConditions.target.projectRoot'));
  assert.ok(missing.missingFields.some(x=>x.field==='executionConditions.runner.safetyFiles'));
  assert.equal(missing.reason.includes('test-safety.json'),false);assert.equal(calls.length,0);
  const pending=await approve(f.input);
  assert.equal(pending.executionApproval.scope.conditions.runner.file,'scripts/test-safe.php');
  assert.deepEqual(pending.executionApproval.scope.conditions.entry,{adapter:'composer-script',script:'test'});
  assert.deepEqual(pending.executionApproval.scope.conditions.environmentFiles,['phpunit.xml']);assert.equal(pending.executionApproval.scope.reviewTrigger,'initial');
  assert.equal(openDatabase().prepare('SELECT count(*) AS n FROM test_execution_conditions').get().n,1);
});
for(const mode of ['local','podman','docker'])test(`${mode}: approved DB conditions reuse without Profile and with a fresh command check`,async()=>{
  const f=fixture(mode),calls=mock(),pending=await approve(f.input);
  const first=await evaluateTest(config,{...f.repeat,executionConditionsId:pending.executionConditionsId});
  assert.equal(first.allowed,true,JSON.stringify(first));assert.equal(first.safetyProfile,undefined);assert.equal(first.executionAssessment.ticket,undefined);
  assert.equal(first.executionAssessment.sourceVerification,mode==='local'?'local-runtime-inspected':'human-approved-container');
  assert.equal(first.executionAssessment.containerInternalsVerified,false);
  mkdirSync(join(f.cwd,'.jev'));f.put('.jev/test-safety.json','{broken Profile, must never read it');
  const again=await evaluateTest(config,{...f.repeat,executionApprovalId:pending.executionReviewId});
  assert.equal(again.allowed,true,JSON.stringify(again));assert.equal(again.codeAssessment.status,'cache-hit');assert.equal(calls.length,3);
  if(mode!=='local')assert.equal(calls[0].state.command,f.input.command,'Jev receives the complete outer invocation');
  rmSync(join(f.cwd,'.jev/test-safety.json'));
  assert.equal((await evaluateTest(config,f.repeat)).allowed,true);
});

test('container runtime declarations and inaccessible host vendor do not imply automatic container verification',async()=>{
  const f=fixture();f.executionConditions.runtime={php:'/unreadable/container/php',composer:'/unreadable/container/composer',composerHome:'/container/secret-home',configFiles:['/container/php.ini']};
  const calls=mock();await approve(f.input);const first=await evaluateTest(config,f.repeat);assert.equal(first.allowed,true,JSON.stringify(first));
  // Host runtime environment is unrelated to the trusted container environment.
  const previous=process.env.PHP_INI_SCAN_DIR;process.env.PHP_INI_SCAN_DIR='/unreadable/container/changed';
  try{assert.equal((await evaluateTest(config,f.repeat)).executionApproval.approvalId,first.executionApproval.approvalId);}finally{if(previous===undefined)delete process.env.PHP_INI_SCAN_DIR;else process.env.PHP_INI_SCAN_DIR=previous;}
  assert.equal(calls.length,3);
});

test('tests, filters and ordinary related code change code review without environment reapproval',async()=>{
  const f=fixture(),calls=mock(),pending=await approve(f.input);assert.equal((await evaluateTest(config,f.repeat)).allowed,true);
  f.put('tests/Feature/SecondTest.php','<?php class SecondTest {}');
  const added=await evaluateTest(config,f.repeat);assert.equal(added.executionApproval.approvalId,pending.executionReviewId);assert.equal(added.allowed,true);
  const selected={...f.repeat,command:'podman exec --workdir /container/project fixture composer test -- tests/Feature/FirstTest.php --filter "First.*"'};
  // The wrapper itself changes fixed execution conditions, so first approve that entry form.
  const selectedPending=await approve({...selected,executionConditions:f.executionConditions});
  const one=await evaluateTest(config,selected);assert.equal(one.allowed,true);
  const before=calls.length;const changedFilter=await evaluateTest(config,{...selected,command:selected.command.replace('First.*','Second.*')});
  assert.equal(changedFilter.executionApproval.approvalId,selectedPending.executionReviewId);assert.equal(changedFilter.codeAssessment.status,'cache-hit');assert.equal(calls.length,before+1);
  f.put('app/Service.php','<?php class ChangedService {}');
  const related=await evaluateTest(config,selected);assert.equal(related.executionApproval.approvalId,selectedPending.executionReviewId);assert.equal(related.codeAssessment.status,'evaluated');
});

test('runner, guard, safety configuration and policy changes supersede approvals; restoring bytes cannot revive an ID',async()=>{
  const f=fixture();mock();let pending=await approve(f.input);
  for(const file of ['scripts/test-safe.php','tests/Support/DatabaseGuard.php','phpunit.xml','composer.json','.env.testing']) {
    let prior;try{prior=readFileSync(join(f.cwd,file),'utf8');}catch{prior=undefined;}
    const changed=file.endsWith('.json')?prior.replace('"@safe"','"@php scripts/test-safe.php"'):file.endsWith('.xml')?prior.replace('<phpunit ','<phpunit colors="true" '):(prior??'')+'\n';
    f.put(file,changed);const stale=await evaluateTest(config,{...f.repeat,executionApprovalId:pending.executionReviewId});
    assert.equal(stale.allowed,false,JSON.stringify(stale));assert.equal(getTestExecutionApproval(openDatabase(),pending.executionReviewId).status,'superseded');
    if(prior===undefined)rmSync(join(f.cwd,file));else f.put(file,prior);
    const restored=await evaluateTest(config,f.repeat);assert.ok(restored.executionReviewId);assert.equal(restored.executionApproval.scope.reviewTrigger,'approval-inactive');assert.notEqual(restored.executionReviewId,pending.executionReviewId);
    transitionTestExecutionApproval(openDatabase(),restored.executionReviewId,'approve',new Date().toISOString());pending=restored;
  }
  f.put('.jev-policy.json',JSON.stringify({version:1,rules:[]}));assert.notEqual((await evaluateTest(config,f.repeat)).executionReviewId,pending.executionReviewId);
});

test('pending evidence is reread; rejection, revocation, expiry and cross-project IDs cannot authorize',async()=>{
  const f=fixture();mock();const pending=await evaluateTest(config,f.input);
  f.put('tests/Support/DatabaseGuard.php','<?php function changedGuard() {}');
  assert.throws(()=>transitionTestExecutionApproval(openDatabase(),pending.executionReviewId,'approve',new Date().toISOString()),/changed/);
  assert.equal(getTestExecutionApproval(openDatabase(),pending.executionReviewId).status,'superseded');
  const next=await evaluateTest(config,f.repeat);transitionTestExecutionApproval(openDatabase(),next.executionReviewId,'reject',new Date().toISOString());
  assert.equal((await evaluateTest(config,{...f.repeat,executionApprovalId:next.executionReviewId})).allowed,false);
  const approved=await approve(f.repeat);const other=fixture();assert.equal((await evaluateTest(config,{...other.repeat,executionApprovalId:approved.executionReviewId})).errorCode,'EXECUTION_APPROVAL_MISMATCH');
  transitionTestExecutionApproval(openDatabase(),approved.executionReviewId,'revoke',new Date().toISOString());assert.equal((await evaluateTest(config,{...f.repeat,executionApprovalId:approved.executionReviewId})).allowed,false);
  const expiring=await evaluateTest(config,f.repeat);openDatabase().prepare("UPDATE test_execution_approvals SET expires_at='2000-01-01T00:00:00.000Z' WHERE approval_id=?").run(expiring.executionReviewId);
  assert.throws(()=>transitionTestExecutionApproval(openDatabase(),expiring.executionReviewId,'approve',new Date().toISOString()),/expired/);
});

test('matching rejects changed container, mode, workdir, arguments, targets, subset and runner bypass',async()=>{
  const f=fixture();mock();const pending=await approve(f.input);
  const commands=[
    f.repeat.command.replace('fixture sh','other sh'),f.repeat.command.replace('podman','docker'),f.repeat.command.replace('/container/project','/other'),
    'podman exec --workdir /container/project fixture composer test -- --configuration other.xml',
    'podman exec --workdir /container/project fixture php vendor/bin/phpunit',
    'podman exec --workdir /container/project fixture composer test -- tests/OtherTest.php',
    'podman exec fixture sh -lc \'cd /container/project && composer test; echo extra\'',
    'podman exec fixture sh -lc \'cd /container/project && composer test && echo extra\'',
    'podman exec -e DB_DATABASE=real fixture composer test',
  ];
  for(const command of commands){const result=await evaluateTest(config,{...f.repeat,command,executionApprovalId:pending.executionReviewId});assert.equal(result.allowed,false,command);assert.equal(result.executionReviewId,undefined,command);}
  f.put('tests/Feature/SecondTest.php','<?php class SecondTest {}');
  assert.equal((await evaluateTest(config,{...f.repeat,testFiles:['tests/Feature/FirstTest.php']})).errorCode,'EXECUTION_TARGET_MISMATCH');
  const node=await evaluateTest(config,{...f.repeat,command:'node --test',isolation:{ephemeralDatabase:true},runtime:{persistentStorageAccess:false}});assert.equal(node.allowed,false);assert.equal(node.reviewId,undefined);
});

test('multiple registrations require selection; container and scope registrations coexist independently',async()=>{
  const f=fixture();mock();const one=await approve(f.input);
  const alternate={...f.input,executionConditions:{...f.executionConditions,selectors:{...f.executionConditions.selectors,allowFilter:false}}};
  const two=await approve(alternate);assert.notEqual(one.executionConditionsId,two.executionConditionsId);
  const ambiguous=await evaluateTest(config,f.repeat);assert.equal(ambiguous.errorCode,'EXECUTION_CONDITIONS_AMBIGUOUS');assert.equal(ambiguous.conditionCandidates.length,2);assert.equal(ambiguous.executionReviewId,undefined);
  assert.equal((await evaluateTest(config,{...f.repeat,executionConditionsId:one.executionConditionsId})).allowed,true);
  const otherContainer={...f.input,command:f.input.command.replace('fixture sh','other sh'),executionConditions:{...f.executionConditions,target:{...f.executionConditions.target,containerName:'other'}}};
  const other=await approve(otherContainer);assert.notEqual(other.executionConditionsId,one.executionConditionsId);
  assert.equal((await evaluateTest(config,{...f.repeat,executionApprovalId:one.executionReviewId,executionConditionsId:two.executionConditionsId})).allowed,false);
  assert.equal((await evaluateTest(config,{...f.repeat,executionConditionsId:one.executionConditionsId,executionConditions:alternate.executionConditions})).allowed,false);
});

test('deny, separate reviews, command evaluation errors and DB failures cannot be bypassed by registration or code cache',async()=>{
  const f=fixture();mock();const pending=await approve(f.input);assert.equal((await evaluateTest(config,f.repeat)).allowed,true);
  mock(0.9);assert.equal((await evaluateTest(config,f.repeat)).decision,'deny');
  globalThis.fetch=async()=>{throw Error('fixture failure');};const failed=await evaluateTest(config,f.repeat);assert.equal(failed.allowed,false);assert.equal(failed.reviewId,undefined);
  mock(0.6);const review=await evaluateTest(config,f.repeat);assert.equal(review.reviewReasons[0].kind,'command-risk');assert.notEqual(review.reviewId,pending.executionReviewId);
  transitionHumanReview(openDatabase(),review.reviewId,'approve',new Date().toISOString());assert.equal((await evaluateTest(config,f.repeat)).allowed,true);
  f.put('app/Service.php','<?php // DROP DATABASE unsafe');assert.equal((await evaluateTest(config,f.repeat)).decision,'deny');
  f.put('app/Service.php','<?php class Service {}');openDatabase().exec('PRAGMA foreign_keys=OFF; DROP TABLE test_execution_conditions');const storage=await evaluateTest(config,f.repeat);assert.equal(storage.allowed,false);assert.equal(storage.executionReviewId,undefined);
});

test('raw-only source changes invalidate identities without storing or transmitting secrets',async()=>{
  const f=fixture(),secret='raw-source-secret-7631';f.put('.env.testing',`DB_PASSWORD=${secret}\n`);f.put('app/Service.php',`<?php $password="${secret}";`);
  const calls=mock(),pending=await approve(f.input);assert.equal((await evaluateTest(config,f.repeat)).allowed,true);
  for(const table of ['test_execution_conditions','test_execution_approvals','fingerprint_cache','human_reviews','audit_log'])assert.equal(JSON.stringify(openDatabase().prepare(`SELECT * FROM ${table}`).all()).includes(secret),false);
  assert.equal(JSON.stringify(calls).includes(secret),false);
  f.put('.env.testing','DB_PASSWORD=raw-source-secret-7632\n');const changed=await evaluateTest(config,f.repeat);assert.notEqual(changed.executionReviewId,pending.executionReviewId);
});

test('unreadable safety source reports the failed file and never produces an approvable review',async()=>{
  const f=fixture();mock();await approve(f.input);rmSync(join(f.cwd,'tests/Support/DatabaseGuard.php'));
  const result=await evaluateTest(config,f.repeat);assert.equal(result.allowed,false);assert.equal(result.executionReviewId,undefined);assert.match(result.reason,/DatabaseGuard.php/);
});

test('MCP exposes DB registration fields, trust boundary, approval and concrete missing fields',async()=>{
  const f=fixture();f.put('runtime/jev.env','JEV_PROVIDER=typesafe\nTYPESAFE_API_KEY=fixture-key\nTYPESAFE_MODEL=jev-1.13.0\n');
  f.put('runtime/mock.mjs',`globalThis.fetch=async(_url,init)=>{const key=Object.keys(JSON.parse(init.body).questions)[0];return new Response(JSON.stringify({model:'jev-1.13.0',answers:{[key]:{type:'noul',noul:0.1}},usage:{input_tokens:1,output_tokens:1}}),{status:200});};`);
  const client=new Client({name:'db-conditions-test',version:'1.0.0'});
  const transport=new StdioClientTransport({command:process.execPath,args:['--import',pathToFileURL(join(f.cwd,'runtime/mock.mjs')).href,join(process.cwd(),'dist/index.js')],env:{...process.env,JEV_ENV_PATH:join(f.cwd,'runtime/jev.env'),JEV_CACHE_DB_PATH:':memory:'},stderr:'pipe'});
  try {
    await client.connect(transport);
    const missing=await client.callTool({name:'jev_check_test',arguments:f.repeat});assert.ok(missing.structuredContent.missingFields.length);
    const pending=(await client.callTool({name:'jev_check_test',arguments:f.input})).structuredContent;assert.ok(pending.executionConditionsId);
    assert.equal((await client.callTool({name:'jev_execution_approve',arguments:{approvalId:pending.executionReviewId}})).structuredContent.ok,true);
    const allowed=(await client.callTool({name:'jev_check_test',arguments:{...f.repeat,executionConditionsId:pending.executionConditionsId}})).structuredContent;
    assert.equal(allowed.allowed,true);assert.equal(allowed.executionAssessment.sourceVerification,'human-approved-container');assert.equal(allowed.safetyProfile,undefined);
  } finally {await client.close();}
});

test('schema 7 migration preserves legacy approval/cache/history and requires explicit migration into file-free registration',async()=>{
  const f=fixture('local'),previousDb=process.env.JEV_CACHE_DB_PATH;resetDatabaseForTests();process.env.JEV_CACHE_DB_PATH=join(f.cwd,'migration.sqlite');mock();
  try {
    mkdirSync(join(f.cwd,'.jev'));
    const {target,...scope}=f.executionConditions;
    const legacyProfile={version:3,name:'legacy',framework:'laravel',environment:'testing',...scope,entry:{adapter:'composer-script',script:'test'},environmentFiles:['phpunit.xml'],runner:{file:'scripts/test-safe.php',safetyFiles:scope.runner.safetyFiles}};
    f.put('.jev/test-safety.json',JSON.stringify(legacyProfile));
    const legacyInput={...f.repeat,safetyProfilePath:join(f.cwd,'.jev/test-safety.json')};
    const legacy=await evaluateTest(config,legacyInput);assert.ok(legacy.executionReviewId,JSON.stringify(legacy));
    transitionTestExecutionApproval(openDatabase(),legacy.executionReviewId,'approve',new Date().toISOString());assert.equal((await evaluateTest(config,legacyInput)).allowed,true);
    const count=openDatabase().prepare('SELECT count(*) AS n FROM fingerprint_cache').get().n;
    const auditCount=openDatabase().prepare('SELECT count(*) AS n FROM audit_log').get().n;
    const columns='approval_id,project_id,profile_path,fingerprint,policy_hash,verifier_version,scope_json,request_json,status,created_at,approved_at,rejected_at,revoked_at,expires_at';
    openDatabase().exec(`DROP INDEX idx_test_execution_active; DROP INDEX idx_test_execution_condition_active;
      ALTER TABLE test_execution_approvals RENAME TO approvals_v8;
      CREATE TABLE test_execution_approvals(approval_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,profile_path TEXT NOT NULL,
        fingerprint TEXT NOT NULL,policy_hash TEXT NOT NULL,verifier_version TEXT NOT NULL,scope_json TEXT NOT NULL,request_json TEXT NOT NULL,
        status TEXT NOT NULL,created_at TEXT NOT NULL,approved_at TEXT,rejected_at TEXT,revoked_at TEXT,expires_at TEXT);
      INSERT INTO test_execution_approvals(${columns}) SELECT ${columns} FROM approvals_v8;
      DROP TABLE approvals_v8; DROP TABLE test_execution_conditions;
      CREATE UNIQUE INDEX idx_test_execution_active ON test_execution_approvals(project_id,profile_path) WHERE status IN ('pending','approved');
      UPDATE schema_meta SET value='7' WHERE key='schema_version';`);
    resetDatabaseForTests();const migrated=openDatabase();
    assert.equal(migrated.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get().value,'8');
    assert.equal(migrated.prepare('SELECT count(*) AS n FROM fingerprint_cache').get().n,count);assert.equal(migrated.prepare('SELECT count(*) AS n FROM audit_log').get().n,auditCount);
    assert.equal(getTestExecutionApproval(migrated,legacy.executionReviewId).status,'approved');
    assert.equal(getTestExecutionApproval(migrated,legacy.executionReviewId).sourceKind,'profile');
    assert.equal((await evaluateTest(config,{...f.repeat,executionApprovalId:legacy.executionReviewId})).errorCode,'EXECUTION_MIGRATION_REQUIRED');
    assert.equal((await evaluateTest(config,{...legacyInput,executionApprovalId:legacy.executionReviewId})).allowed,true);
    const registration=await approve(f.input);assert.notEqual(registration.executionReviewId,legacy.executionReviewId);
    rmSync(join(f.cwd,'.jev/test-safety.json'));
    assert.equal((await evaluateTest(config,f.repeat)).allowed,true);assert.equal(getTestExecutionApproval(migrated,legacy.executionReviewId).status,'approved','legacy history was not silently transformed');
    assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(),[]);
  } finally {resetDatabaseForTests();if(previousDb===undefined)delete process.env.JEV_CACHE_DB_PATH;else process.env.JEV_CACHE_DB_PATH=previousDb;}
});

test('direct PHP runner uses DB conditions; local runtime and dependency inspection remains mandatory',async()=>{
  const f=fixture('local');mock();f.input.command=`${f.executionConditions.runtime.php} scripts/test-safe.php`;f.repeat.command=f.input.command;
  const pending=await approve(f.input);assert.equal(pending.executionApproval.scope.conditions.entry.adapter,'php-runner');
  assert.equal((await evaluateTest(config,f.repeat)).allowed,true);
  f.put('runtime/php',readFileSync(join(f.cwd,'runtime/php'),'utf8')+'# changed executable\n');const changed=await evaluateTest(config,f.repeat);assert.notEqual(changed.executionReviewId,pending.executionReviewId);
  rmSync(join(f.cwd,'vendor/composer/installed.json'));const missing=await evaluateTest(config,f.repeat);assert.equal(missing.allowed,false);assert.equal(missing.executionReviewId,undefined);assert.equal(missing.errorCode,'EXECUTION_EVIDENCE_INCOMPLETE');
});

test('container XML may bootstrap container vendor without treating it as a host runtime dependency',async()=>{
  const f=fixture();mock();f.put('phpunit.xml','<phpunit bootstrap="vendor/autoload.php"><testsuites><testsuite name="Feature"><directory>tests/Feature</directory></testsuite></testsuites></phpunit>');
  await approve(f.input);assert.equal((await evaluateTest(config,f.repeat)).allowed,true);
});

test('nested container workdir maps below host project root and retains root project policy',async()=>{
  const f=fixture();mock();mkdirSync(join(f.cwd,'nested'));
  for(const item of ['composer.json','composer.lock','phpunit.xml','scripts','tests','app'])cpSync(join(f.cwd,item),join(f.cwd,'nested',item),{recursive:true});
  f.input.command='podman exec --workdir /container/project/nested fixture composer test';
  f.repeat.command=f.input.command;f.executionConditions.target.cwd='/container/project/nested';
  const pending=await approve(f.input);
  const allowed=await evaluateTest(config,{...f.repeat,executionConditionsId:pending.executionConditionsId,testFiles:['nested/tests/Feature/FirstTest.php']});
  assert.equal(allowed.allowed,true,JSON.stringify(allowed));assert.equal(allowed.executionApproval.scope.projectRoot,f.cwd);assert.equal(allowed.executionApproval.scope.hostWorkingDirectory,join(f.cwd,'nested'));
  f.put('.jev-policy.json',JSON.stringify({version:1,rules:[{name:'deny-nested',match:{type:'contains',value:'class FirstTest'},decision:'deny',category:'scope',reason:'Root project policy applies to nested test source.'}]}));
  assert.equal((await evaluateTest(config,f.repeat)).decision,'deny');
  const outside={...f.input,command:f.input.command.replace('/container/project/nested','/outside'),executionConditions:{...f.executionConditions,target:{...f.executionConditions.target,cwd:'/outside'}}};
  assert.equal((await evaluateTest(config,outside)).errorCode,'EXECUTION_CONDITIONS_MISMATCH');
});
