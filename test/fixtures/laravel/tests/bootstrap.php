<?php
declare(strict_types=1);

require dirname(__DIR__) . '/vendor/autoload.php';
require __DIR__ . '/Support/DatabaseGuard.php';

$capsule = new Illuminate\Database\Capsule\Manager();
$container = $capsule->getContainer();
$container->instance('config', new Illuminate\Config\Repository(['database' => [
    'default' => 'sqlite',
    'connections' => ['sqlite' => ['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '', 'foreign_key_constraints' => true]],
]]));
$container->instance('db', new FixtureDatabaseGuard($container, new Illuminate\Database\Connectors\ConnectionFactory($container)));
$GLOBALS['fixture_db'] = $container['db'];
$GLOBALS['fixture_config'] = $container['config'];

if (getenv('DB_CONNECTION') !== 'sqlite' || getenv('DB_DATABASE') !== ':memory:' || is_file(dirname(__DIR__) . '/bootstrap/cache/config.php')) {
    throw new RuntimeException('Runner failed to enforce the test environment or clear config cache.');
}
$GLOBALS['fixture_db']->connection();
