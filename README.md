# jev-mcp-server

Cloudflare `typesafe/jev`を利用して、Codexから実行予定のコマンドの危険性を判定するSTDIO MCP Serverです。

## Configuration

認証情報はリポジトリに置かず、`/root/.config/jev-mcp/.env`に保存します。

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

API TokenはログやMCPレスポンスには出力されません。

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
      "args": ["/root/jev-mcp-server/dist/index.js"]
    }
  }
}
```

## Tool

`jev_check_command`を提供します。

- `command`: 必須。評価対象のコマンド。実行はしません。
- `context`: 任意。環境や対象に関する追加情報。

結果には`dangerous`、`allowed`、`needsHumanReview`、`decision`が含まれます。CloudflareまたはJevが利用できない場合は、`allowed=false`かつ`needsHumanReview=true`のフェイルクローズになります。

STDIO MCP通信を維持するため、通常ログとエラーログはstdoutではなくstderrへ出力します。
