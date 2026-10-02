import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { evaluateTest } from '../../dist/test-checker.js';
import { openDatabase, resetDatabaseForTests } from '../../dist/storage/sqlite.js';
import { transitionTestExecutionApproval } from '../../dist/storage/test-execution-approval.js';

const root=resolve('.'), temporary=mkdtempSync(join(tmpdir(),'jev-laravel-integration-'));
const containerName=`jev-fixture-${process.pid}-${Date.now()}`;
let containerStarted=false;
const previousFetch=globalThis.fetch, previousDb=process.env.JEV_CACHE_DB_PATH;
const image=process.env.JEV_FIXTURE_RUNTIME_IMAGE ?? 'localhost/jev-laravel-fixture-runtime';
function run(args) {
  const result=spawnSync('podman',args,{encoding:'utf8',maxBuffer:16*1024*1024});
  if(result.status!==0)throw Error(result.error?.message??result.stdout+result.stderr);
  return result.stdout;
}
try {
  cpSync(join(root,'test/fixtures/laravel'),join(temporary,'project'),{recursive:true});
  console.log('Building isolated PHP/Composer runtime and installing fixture dependencies in a temporary directory.');
  run(['build','--quiet','-t',image,join(root,'test/fixtures/laravel')]);
  const base=['run','--rm','--security-opt','label=disable','-v',`${temporary}/project:/fixture`,'-w','/fixture'];
  run([...base,image,'composer','--no-plugins','install','--no-interaction','--no-scripts','--prefer-dist']);
  console.log('Running the gate and Laravel/PHPUnit runner with networking disabled and no host database mounts.');
  process.stdout.write(run([...base,'--network','none','-e','JEV_CACHE_DB_PATH=:memory:','-e','COMPOSER_HOME=/tmp/jev-composer-home',
    '-v',`${root}/dist:/mcp/dist:ro`,'-v',`${root}/policies:/mcp/policies:ro`,
    '-v',`${root}/node_modules:/mcp/node_modules:ro`,'-v',`${root}/test/integration:/mcp/test/integration:ro`,
    image,'/usr/local/bin/node','/mcp/test/integration/laravel-gate.mjs']));
  console.log('Running the MCP evaluator on the host against the approved named Podman container.');
  run(['run','--rm','-d','--name',containerName,'--network','none','--security-opt','label=disable','-v',`${temporary}/project:/fixture`,image,'php','-r','while (true) { sleep(60); }']);
  containerStarted=true;
  process.env.JEV_CACHE_DB_PATH=join(temporary,'host-gate.sqlite');
  const config={provider:'typesafe',apiKey:'fixture-only-key',requestedModel:'jev-1.13.0'};
  const requests=[];
  globalThis.fetch=async(_url,init)=>{const body=JSON.parse(init.body);requests.push(body);const key=Object.keys(body.questions)[0];return new Response(JSON.stringify({model:config.requestedModel,answers:{[key]:{type:'noul',noul:0.1}},usage:{input_tokens:1,output_tokens:1}}),{status:200});};
  const project=join(temporary,'project');
  assert.equal(existsSync(join(project,'.jev/test-safety.json')),false);
  const repeat={command:`podman exec --workdir /fixture ${containerName} composer --no-plugins test`,cwd:project,framework:'laravel',environment:'testing'};
  const executionConditions={target:{mode:'podman',containerName,projectRoot:'/fixture',cwd:'/fixture'},
    runner:{safetyFiles:['tests/Support/DatabaseGuard.php']},selectors:{filePatterns:['tests/Feature/**'],allowFilter:true,allowFullSuite:true},
    codeReviewRoots:['tests/Support','composer.lock'],environmentFiles:['phpunit.xml','composer.lock'],resources:{database:{policy:'sqlite-memory',rejectFallback:true,rejectAdditionalConnections:true},filesystem:{writableRoots:['bootstrap/cache']},network:{policy:'deny'},credentials:{policy:'deny'}}};
  const pending=await evaluateTest(config,{...repeat,executionConditions});
  assert.ok(pending.executionReviewId,JSON.stringify(pending));
  transitionTestExecutionApproval(openDatabase(),pending.executionReviewId,'approve',new Date().toISOString());
  const allowed=await evaluateTest(config,repeat);assert.equal(allowed.allowed,true,JSON.stringify(allowed));
  assert.equal(allowed.executionAssessment.sourceVerification,'human-approved-container');assert.equal(allowed.executionAssessment.ticket,undefined);
  const actual=run(['exec','--workdir','/fixture',containerName,'composer','--no-plugins','test']);assert.match(actual,/OK \(3 tests, 4 assertions\)/u);process.stdout.write(actual);
  const again=await evaluateTest(config,{...repeat,executionConditionsId:pending.executionConditionsId});assert.equal(again.allowed,true);assert.equal(again.codeAssessment.status,'cache-hit');
  assert.equal(requests.filter(r=>'command_dangerous' in r.questions).length,2,'host gate re-evaluates commands every time');
  writeFileSync(join(project,'tests/Feature/AdditionalTest.php'),'<?php /* added source must be reviewed without environment reapproval */');
  const added=await evaluateTest(config,repeat);assert.equal(added.allowed,true);assert.equal(added.executionApproval.approvalId,pending.executionReviewId);rmSync(join(project,'tests/Feature/AdditionalTest.php'));
  const guard=join(project,'tests/Support/DatabaseGuard.php');writeFileSync(guard,readFileSync(guard,'utf8')+'\n// reviewed condition change\n');
  const changed=await evaluateTest(config,{...repeat,executionApprovalId:pending.executionReviewId});assert.equal(changed.allowed,false);
  const replacement=await evaluateTest(config,repeat);assert.ok(replacement.executionReviewId);assert.notEqual(replacement.executionReviewId,pending.executionReviewId);
  transitionTestExecutionApproval(openDatabase(),replacement.executionReviewId,'approve',new Date().toISOString());assert.equal((await evaluateTest(config,repeat)).allowed,true);
  assert.match(run(['exec','--workdir','/fixture',containerName,'composer','--no-plugins','test']),/OK \(3 tests, 4 assertions\)/u);
  console.log('Host gate + Podman: no Profile/Ticket; exact container command; approval/cache reused; added tests accepted; changed guard requires reapproval; actual DB guard tests pass.');
} finally {
  if(containerStarted)run(['rm','-f',containerName]);
  globalThis.fetch=previousFetch;resetDatabaseForTests();
  if(previousDb===undefined)delete process.env.JEV_CACHE_DB_PATH;else process.env.JEV_CACHE_DB_PATH=previousDb;
  rmSync(temporary,{recursive:true,force:true});
}
