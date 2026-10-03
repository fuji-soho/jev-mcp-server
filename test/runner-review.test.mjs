import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectRunner } from '../dist/runner-review.js';

const entry = 'vendor/bin/phpunit';
const shell = `<?php
$clear = escapeshellarg(PHP_BINARY).' artisan config:clear';
passthru($clear, $clearStatus);
if ($clearStatus !== 0) { exit(1); }
$args = array_slice($argv, 1);
$command = escapeshellarg(PHP_BINARY).' vendor/bin/phpunit';
foreach ($args as $arg) { $command .= ' '.escapeshellarg($arg); }
passthru($command, $status);
exit($status);`;

test('fixed passthru preparation and escaped selector forwarding are reviewable process evidence', () => {
  assert.deepEqual(inspectRunner(shell, entry), {
    processes: [
      { api: 'passthru', executable: 'PHP_BINARY', arguments: ['artisan', 'config:clear'], forwarding: 'none' },
      { api: 'passthru', executable: 'PHP_BINARY', arguments: [entry], forwarding: 'escaped-selectors' },
    ], needsLaravelBootstrap: true,
  });
});
test('comments and quoted text are not process calls', () => {
  assert.deepEqual(inspectRunner('<?php // passthru($unsafe); eval($unsafe);\n$text="system(foo)"; /* shell_exec(foo) */',entry).processes, []);
});
test('argv-array proc_open remains supported without a shell', () => {
  assert.equal(inspectRunner('<?php proc_open([PHP_BINARY,"vendor/bin/phpunit",...array_slice($argv,1)], [], $pipes);',entry).processes[0].forwarding, 'argv-array');
});
test('global qualified passthru and inline fixed commands are supported', () => {
  assert.equal(inspectRunner("<?php \\passthru(\\escapeshellarg(PHP_BINARY).' vendor/bin/phpunit', $exit);",entry).processes[0].api, 'passthru');
});
for (const [label, source] of [
  ['constant impostor', "<?php const php_binary = '/bin/sh'; passthru(escapeshellarg(php_binary).' vendor/bin/phpunit');"],
  ['imported escape function', "<?php use function Evil\\escapeshellarg; passthru(escapeshellarg(PHP_BINARY).' vendor/bin/phpunit');"],
  ['imported process alias', '<?php use function passthru as run; run($_GET["cmd"]);'],
  ['selector deletion', shell.replace('foreach ($args', 'unset($args[0]); foreach ($args')],
  ['selector element mutation by function', shell.replace('foreach ($args', 'mutate($args[0]); foreach ($args')],
  ['conditional selector dropping', shell.replace('$command .=', 'if ($arg === "skip") { continue; } $command .=')],
  ['raw argv', shell.replace("escapeshellarg($arg)", '$arg')],
  ['arbitrary command', '<?php passthru($_GET["cmd"]);'],
  ['raw executable', "<?php passthru(PHP_BINARY.' vendor/bin/phpunit');"],
  ['shell operator', "<?php passthru(escapeshellarg(PHP_BINARY).' vendor/bin/phpunit; rm -rf data');"],
  ['alternate entry', "<?php passthru(escapeshellarg(PHP_BINARY).' other.php');"],
  ['preparation selector forwarding', shell.replace("$command = escapeshellarg(PHP_BINARY).' vendor/bin/phpunit';", "$command = escapeshellarg(PHP_BINARY).' artisan config:clear';")],
  ['command reassignment', shell.replace('passthru($command, $status);', '$command = $_GET["cmd"]; passthru($command, $status);')],
  ['argument reassignment', shell.replace("$command .=", "$arg = $_GET['cmd']; $command .=")],
  ['argv mutation', shell.replace('$args =', '$argv[1] = "--configuration unsafe.xml"; $args =')],
  ['reference alias', shell.replace('$args =', '$alias =& $argv; $args =')],
  ['command mutation by unknown function', shell.replace('passthru($command, $status);', 'mutate($command); passthru($command, $status);')],
  ['argument mutation by unknown function', shell.replace("$command .=", "mutate($arg); $command .=")],
  ['argv mutation by unknown function', shell.replace('$args =', 'mutate($argv); $args =')],
  ['globals mutation', shell.replace('$args =', '$GLOBALS["argv"] = $_GET; $args =')],
  ['implicit variable mutation', shell.replace('$args =', 'extract($_GET); $args =')],
  ['dynamic invocation', '<?php $fn="passthru"; $fn($_GET["cmd"]);'],
  ['eval', '<?php eval($_GET["cmd"]);'],
  ['backticks', '<?php `rm -rf data`;'],
  ['other shell function', '<?php shell_exec("php vendor/bin/phpunit");'],
  ['string proc_open', '<?php proc_open("php vendor/bin/phpunit", [], $pipes);'],
  ['arbitrary array target', '<?php proc_open(["sh","-lc",$_GET["cmd"]], [], $pipes);'],
  ['array arbitrary extra option', '<?php proc_open([PHP_BINARY,"vendor/bin/phpunit","--configuration","other.xml"], [], $pipes);'],
  ['unescaped unsupported scope', '<?php function run() { passthru($_GET["cmd"]); }'],
  ['malformed PHP', '<?php passthru('],
]) test(`runner syntax fails closed for ${label}`, () => assert.throws(() => inspectRunner(source,entry)));
