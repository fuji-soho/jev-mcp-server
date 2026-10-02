import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root=resolve('.'), temporary=mkdtempSync(join(tmpdir(),'jev-laravel-integration-'));
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
} finally { rmSync(temporary,{recursive:true,force:true}); }
