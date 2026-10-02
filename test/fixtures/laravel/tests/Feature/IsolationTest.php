<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class IsolationTest extends TestCase
{
    public function testUsesActualDisposableConnection(): void
    {
        $connection = $GLOBALS['fixture_db']->connection();
        $connection->getSchemaBuilder()->create('fixture_rows', fn ($table) => $table->increments('id'));
        $connection->table('fixture_rows')->insert(['id' => 1]);
        self::assertSame(1, $connection->table('fixture_rows')->count());
        self::assertSame(':memory:', $connection->getConfig('database'));
    }

    public function testRejectsActualPersistentSqliteTarget(): void
    {
        $GLOBALS['fixture_config']['database.connections.sqlite.database'] = '/tmp/jev-disposable-probe.sqlite';
        $GLOBALS['fixture_db']->purge('sqlite');
        try {
            $this->expectException(RuntimeException::class);
            $GLOBALS['fixture_db']->connection('sqlite');
        } finally {
            $GLOBALS['fixture_config']['database.connections.sqlite.database'] = ':memory:';
        }
    }

    public function testRejectsAdditionalAndFallbackConnections(): void
    {
        $GLOBALS['fixture_config']['database.connections.unapproved'] = ['driver' => 'mysql', 'database' => 'disposable_probe'];
        $GLOBALS['fixture_config']['database.default'] = 'unapproved';
        try {
            $this->expectException(RuntimeException::class);
            $GLOBALS['fixture_db']->connection();
        } finally {
            $GLOBALS['fixture_config']['database.default'] = 'sqlite';
        }
    }
}
