<?php
declare(strict_types=1);

// Existing-runner style: no Ticket SDK, no MCP calls, and no shell concatenation.
chdir(dirname(__DIR__));
$guard = 'tests/Support/DatabaseGuard.php';
if (!is_file($guard)) { fwrite(STDERR, "Missing DB guard\n"); exit(1); }
$cache = 'bootstrap/cache/config.php';
$prior = is_file($cache) ? file_get_contents($cache) : null;
if ($prior !== null && !unlink($cache)) { exit(1); }
try {
    $env = getenv();
    foreach (array_keys($env) as $key) {
        if (str_starts_with($key, 'DB_')) { unset($env[$key]); }
    }
    $env['APP_ENV'] = 'testing';
    $env['DB_CONNECTION'] = 'sqlite';
    $env['DB_DATABASE'] = ':memory:';
    $process = proc_open([PHP_BINARY, 'vendor/bin/phpunit', ...array_slice($argv, 1)], [0 => STDIN, 1 => STDOUT, 2 => STDERR], $pipes, getcwd(), $env);
    $status = is_resource($process) ? proc_close($process) : 1;
} finally {
    if ($prior !== null) { file_put_contents($cache, $prior); }
}
exit($status);
