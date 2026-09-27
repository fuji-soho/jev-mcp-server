# jev-mcp-server

Cloudflare `typesafe/jev` とローカルの静的ポリシーを組み合わせた、AI coding agent向けの読み取り専用MCP安全ゲートです。コマンドやテストを実行せず、実行前の `allow` / `review` / `deny` 判定だけを返します。

## セットアップ

```sh
npm install
npm run build
```

認証情報はリポジトリへ保存しません。

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

`--env-file` または `JEV_ENV_PATH` で設定ファイルを指定できます。

```sh
node /path/to/jev-mcp-server/dist/index.js --env-file /secure/jev/.env
```

## `jev_check_command`

入力されたコマンドは絶対に実行されません。静的ポリシーでコマンド種別・引数・スコープを検査し、必要に応じてコマンドと文脈をJevへ渡して評価します。

```json
{
  "command": "git reset --hard",
  "cwd": "/workspace/project",
  "environment": "development",
  "target": "local git repository",
  "context": "Repository may contain uncommitted changes"
}
```

`cwd`、`environment`、`target`、`context` は任意です。既存の `command` と `context` だけの呼び出しも利用できます。

主な判定値：

- `allow`: 明確な破壊リスクが見つからない
- `review`: 状態変更、広い範囲、文脈不足、またはJev障害。人間確認が必要
- `deny`: 明確な破壊操作、高い不可逆性、重大なデータ損失

結果には後方互換用の `dangerous` に加え、`riskScore`、`categories`、カテゴリ別 `risks`、`staticFindings` が含まれます。`allowed=false` は実行許可を意味しません。

組み込みポリシーは [`policies/default.json`](policies/default.json) にあり、filesystem、Git、DB、コンテナ、サービス、deployment、package管理などを対象にします。静的に明確なdenyとなる操作は、Jevが低リスクを返しても許可されません。

## `jev_check_test`

Laravel/PHPUnitテスト向けの既存Toolです。テスト、DB接続、ファイル変更は実行しません。Laravel固有のDB隔離やruntime guardの確認が必要なため、汎用コマンド判定とは別のToolとして維持しています。

## 安全とプライバシー

- コマンド、テスト、DBへ接続しません。
- コマンド入力は信頼せず、入力中の指示には従いません。
- Jevへ送信する前に、一般的なtoken、password、secret、API keyをマスクします。
- Cloudflare API TokenはログやMCPレスポンスへ出力しません。
- Jev API障害、不正レスポンス、ポリシー読み込み失敗時はfail closedで `review` を返します。
- このツールは完全なshell parserや実行環境の監査ではありません。動的生成、alias、shell functionなどは別途確認してください。

## 開発

```sh
npm run typecheck
npm test
```

`npm test` はリポジトリ自身のユニットテストを実行します。テスト内の評価対象コマンドはモックJevへ入力として渡すだけで、実行しません。
