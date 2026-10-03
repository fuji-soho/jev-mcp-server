<?php

declare(strict_types=1);

// PHPUnit bootstrap loads the connection guard; the runner does not mention its filename.
// Ensure the preparation command also starts Laravel with the approved memory DB.
putenv('APP_ENV=testing');
putenv('DB_CONNECTION=sqlite');
putenv('DB_DATABASE=:memory:');
putenv('DB_URL=');

$projectRoot = dirname(__DIR__);
$configCachePath = $projectRoot.'/bootstrap/cache/config.php';
$backupPath = tempnam($projectRoot.'/bootstrap/cache', 'jev-config-cache-');
$hadConfigCache = is_file($configCachePath);
$exitCode = 1;

if ($backupPath === false) {
    fwrite(STDERR, "設定キャッシュの退避先を作成できませんでした。\n");
    exit(1);
}

try {
    if ($hadConfigCache && ! copy($configCachePath, $backupPath)) {
        throw new RuntimeException('設定キャッシュを退避できませんでした。');
    }

    // Remove the cached configuration before artisan boots Laravel.
    if ($hadConfigCache && ! unlink($configCachePath)) {
        throw new RuntimeException('事前起動前に設定キャッシュを削除できませんでした。');
    }

    chdir($projectRoot);

    $clearCommand = escapeshellarg(PHP_BINARY).' artisan config:clear';
    passthru($clearCommand, $clearExitCode);

    if ($clearExitCode !== 0) {
        throw new RuntimeException('テスト前の設定キャッシュ削除に失敗しました。');
    }

    $testArguments = array_slice($argv, 1);
    $testCommand = escapeshellarg(PHP_BINARY).' vendor/bin/phpunit';

    foreach ($testArguments as $argument) {
        $testCommand .= ' '.escapeshellarg($argument);
    }

    passthru($testCommand, $exitCode);
} catch (Throwable $exception) {
    fwrite(STDERR, $exception->getMessage()."\n");
    $exitCode = 1;
} finally {
    if ($hadConfigCache) {
        if (! copy($backupPath, $configCachePath)) {
            fwrite(STDERR, "元の設定キャッシュを復元できませんでした。\n");
            $exitCode = 1;
        }
    } elseif (is_file($configCachePath) && ! unlink($configCachePath)) {
        fwrite(STDERR, "生成された設定キャッシュを削除できませんでした。\n");
        $exitCode = 1;
    }

    unlink($backupPath);
}

exit($exitCode);
