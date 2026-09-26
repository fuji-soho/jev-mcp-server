# jev-mcp-server

Cloudflare `typesafe/jev`を利用して、Codexから実行予定のコマンドの危険性を判定するSTDIO MCP Serverです。

## Configuration

認証情報はリポジトリに置かず、デフォルトでは`/root/jev-mcp-server/.env`に保存します。

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

API TokenはログやMCPレスポンスには出力されません。

別の場所に`.env`を置く場合は、起動引数または`JEV_ENV_PATH`でパスを指定できます。
指定の優先順位は`--env-file`、`JEV_ENV_PATH`、デフォルトパスの順です。
設定ファイルはマージせず、選択されたファイルだけを読み込みます。

```sh
node /root/jev-mcp-server/dist/index.js --env-file /secure/jev/.env
```

```sh
JEV_ENV_PATH=/secure/jev/.env node /root/jev-mcp-server/dist/index.js
```

## Build and run

```sh
npm run build
npm start
```

CodexのMCP設定では、ビルド後の`dist/index.js`をNode.jsで起動します。

```json
{
  "mcpServers": {
    "jev": {
      "command": "node",
      "args": [
        "/root/jev-mcp-server/dist/index.js",
        "--env-file",
        "/secure/jev/.env"
      ]
    }
  }
}
```

## Tool

以下のToolを提供します。

### `jev_check_command`

- `command`: 必須。評価対象のコマンド。実行はしません。
- `context`: 任意。環境や対象に関する追加情報。

結果には`dangerous`、`allowed`、`needsHumanReview`、`decision`が含まれます。CloudflareまたはJevが利用できない場合は、`allowed=false`かつ`needsHumanReview=true`のフェイルクローズになります。

STDIO MCP通信を維持するため、通常ログとエラーログはstdoutではなくstderrへ出力します。

### `jev_check_test`

Laravel/PHPUnitのテスト実行前に、既存データを破壊・初期化・truncateしたり、永続DBへ書き込んだりする危険性を評価します。

このToolは安全性を評価するだけです。PHPUnit、`php artisan`、DB接続、ファイル変更は行いません。

入力:

- `command`: 必須。例: `php artisan test --filter=ApplicationTest`
- `testCode`: 任意。実行対象または関連するテストコード
- `diff`: 任意。関連する`git diff`
- `context`: 任意。LaravelのDB設定、`APP_ENV`、テスト環境、設定キャッシュの状態など
- `runtimeDatabase`: 任意。実効DB接続（`connection`、`database`、`enforced`）
- `configCache`: 任意。テスト前のclearとテスト後のrestoreの実装上の確認
- `runtimeGuard`: 任意。実接続検証、永続DB拒否、fallback拒否の実装上の確認
- `persistentDatabaseAccess`: 任意。永続DBへ接続可能かどうか

`DatabaseTruncation`、`migrate:fresh`、`db:wipe`、`TRUNCATE`、`DROP TABLE`、`DROP DATABASE`などは静的にも検出します。静的な危険パターンがある場合、Jevが低リスクと判断しても`allowed=false`になります。`RefreshDatabase`と`DatabaseMigrations`は、永続DBの実効ターゲットと組み合わさる場合にblockingな危険として扱います。

DB接続先やruntime guardが十分確認できない場合は、安全側に倒して`needsHumanReview=true`になります。`phpunit.xml`や`.env.testing`の記述、コメント、READMEだけではallowしません。SQLite `:memory:` がruntimeで強制され、config cacheのclear/restore、実接続先検証、永続DB/fallback拒否がすべて確認できる場合だけ、persistent DBの静的denyを解除してJevの最終評価へ進みます。

構造化入力の例:

```json
{
  "runtimeDatabase": {
    "connection": "sqlite",
    "database": ":memory:",
    "enforced": true
  },
  "configCache": {
    "clearedBeforeTest": true,
    "restoredAfterTest": true
  },
  "runtimeGuard": {
    "enabled": true,
    "checksActualConnection": true,
    "rejectsPersistentDatabase": true,
    "rejectsFallback": true
  },
  "persistentDatabaseAccess": false
}
```

出力には既存Toolと同じく`dangerous`、`allowed`、`needsHumanReview`、`decision`、`reason`、`model`が含まれ、追加で`staticFindings`が含まれます。CloudflareまたはJevが利用できない場合は、`allowed=false`かつ`needsHumanReview=true`のフェイルクローズになります。

利用例:

```json
{
  "command": "php artisan test",
  "testCode": "use Illuminate\\Foundation\\Testing\\RefreshDatabase; class ApplicationTest extends TestCase { use RefreshDatabase; }",
  "context": "APP_ENV=testing\nDB_CONNECTION=mysql\nDB_DATABASE=production_database\nconfig cache may be active"
}
```

この例では既存DBを初期化・変更する可能性があるため、安全許可されません。
