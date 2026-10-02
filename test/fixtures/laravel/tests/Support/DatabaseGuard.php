<?php
declare(strict_types=1);

use Illuminate\Database\DatabaseManager;

final class FixtureDatabaseGuard extends DatabaseManager
{
    public function connection($name = null)
    {
        $name ??= $this->getDefaultConnection();
        $configuration = $this->app['config']["database.connections.$name"];
        if ($name !== 'sqlite' || !is_array($configuration) || $configuration['driver'] !== 'sqlite'
            || $configuration['database'] !== ':memory:' || isset($configuration['read']) || isset($configuration['write'])) {
            throw new RuntimeException('Persistent, fallback or additional DB connections are forbidden.');
        }
        $connection = parent::connection($name);
        foreach ($connection->getPdo()->query('PRAGMA database_list')->fetchAll(PDO::FETCH_ASSOC) as $database) {
            if ($database['file'] !== '') { throw new RuntimeException('Actual PDO connection is persistent.'); }
        }
        return $connection;
    }
}
