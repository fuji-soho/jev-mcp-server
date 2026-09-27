# jev-mcp-server

Cloudflare `typesafe/jev` とローカルの静的ポリシーを組み合わせた、AI coding agent向けの読み取り専用MCP安全ゲートです。コマンドやテストを実行せず、実行前の `allow` / `review` / `deny` 判定だけを返します。

## セットアップ

```sh
npm install
npm run build
```

認証情報はリポジトリへ保存しません。

リポジトリ直下に `/jev-mcp-server/.env` ファイルを作成し、認証情報を記載してください。

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

`.env` は `.gitignore` の対象になっています。認証情報を含むため、ファイルの公開やコミットはしないでください。

`--env-file` または `JEV_ENV_PATH` で設定ファイルを指定できます。たとえば、作成した `/jev-mcp-server/.env` を使う場合は次のように起動します。

```sh
node /jev-mcp-server/dist/index.js --env-file /jev-mcp-server/.env
```

### CodexへのMCPサーバー登録

Codexから利用する場合は、次の手順でMCPサーバーを追加してください。

1. Codexを開きます。
2. **プラグイン** → **設定** → **MCPサーバーを追加**を選択します。
3. 次の内容を入力して保存します。

   - **名前**: `jev-mcp-server`
   - **コマンド**: `node`
   - **引数**: `/jev-mcp-server/dist/index.js --env-file /jev-mcp-server/.env`

引数を個別に入力する画面では、次の3つに分けて入力してください。

```text
/jev-mcp-server/dist/index.js
--env-file
/jev-mcp-server/.env
```

保存後、MCPサーバーが有効になっていることを確認し、新しいチャットで利用してください。Codex CLIを利用する場合は、次のコマンドでも登録できます。

```sh
codex mcp add jev-mcp-server -- node /jev-mcp-server/dist/index.js --env-file /jev-mcp-server/.env
```

Codex利用者は、[`examples/AGENTS.ja.md`](examples/AGENTS.ja.md)をプロジェクトルートの`AGENTS.md`としてコピーし、Jev Safety Gateの推奨設定をCodexに適用できます。

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

### User / Project policy

利用者独自のルールを追加できます。User policyは、Linux/macOSでは`$XDG_CONFIG_HOME/jev-mcp/policy.json`（未設定時は`~/.config/jev-mcp/policy.json`）、Windowsでは`%APPDATA%/jev-mcp/policy.json`です。Project policyは、評価対象の`cwd`直下に`.jev-policy.json`として置きます。`cwd`未指定時にサーバー自身のディレクトリをProject policyとして扱うことはありません。

```json
{
  "version": 1,
  "rules": [
    {
      "name": "deny-force-push",
      "match": { "type": "contains", "value": "git push --force" },
      "decision": "deny",
      "category": "git",
      "reason": "Force push is prohibited."
    }
  ]
}
```

`match.type`は`contains`または`exact`を指定できます。簡略形式の`pattern`は`contains`として扱われます。Built-in、User、Project、Jevの判定は`allow < review < deny`で統合されるため、User／Projectの`allow`で、より厳しい判定を解除することはできません。policyの構文・schema・読み込みに失敗した場合は、policyを無視せず`review`で停止します。レスポンスの`policyFindings`で、該当したsource、rule、理由を確認できます。

## `jev_check_test`

`jev_check_test`は、言語やフレームワークを問わず、テスト実行時の永続データ、データベース、ファイルシステム、外部サービス、本番環境、credential、ネットワーク、破壊的cleanup、隔離状態を評価します。テスト、コマンド、DB接続は絶対に実行せず、入力されたcommandは評価のための未信頼データとしてのみ扱います。

最終判定が`review`の場合、Serverは短時間だけ有効なHuman Reviewを保存し、`reviewId`を返します。人間が明示的に承認した後は、`jev_review_approve`へその`reviewId`だけを渡してください。Serverが保存済みのproject、command、対象ファイル、Policy、runtime context、Safety Fingerprintを読み出して照合します。呼び出し側からfingerprintやcommandを指定して承認対象を変更することはできません。同じFingerprintの安全条件が維持されている場合だけ後続チェックで利用でき、変更があれば再評価されます。`deny`は常に優先され、Human Approvalで覆すことはできません。`jev_review_reject`でpending reviewを恒久的に拒否できます。

最小入力は次の形式です。

```json
{ "command": "npm test" }
```

必要に応じて`testCode`、`diff`、`cwd`、`environment`、`framework`、`context`、`isolation`、`runtime`を追加できます。generic policyは常に適用され、`framework`指定時だけframework-specific policyが追加適用されます。Laravel固有ルールは[`policies/tests/laravel.json`](policies/tests/laravel.json)にあります。

### Safety Profile

プロジェクトは`.jev/test-safety.json`で、再利用するテスト安全条件を定義できます。ProfileはLaravel専用ではなく、安全関連ファイル、test runner、DB、隔離、runtime条件を宣言します。Profileは許可証や安全保証ではなく、Built-in／User／Project PolicyやJevの`deny`を上書きしません。

Profileに記載したファイルはSHA-256でfingerprint化します。verified stateはリポジトリ外のユーザー設定ディレクトリ（または`JEV_TEST_SAFETY_STATE_PATH`）へ保存し、Gitへコミットしません。`jev_check_test`は読み取り専用のまま、明示的なverificationでstateを作成します。

```sh
npm run verify-test-safety -- --cwd /path/to/project --input /path/to/jev-verification-input.json
```

人間による初回確認後、Profile、対象ファイル、runtime条件が同じで、Jevも低リスクなら、同じ確認を毎回要求せず`allow`にできます。Profile変更、対象ファイル欠落、runner/framework変更、隔離条件変更、無効なProfile、Policy違反、新しいリスクがあれば`review`または`deny`に戻ります。Profileやverified stateへcredentialや`.env`の実値を保存しないでください。

本サーバーは入力されたevidenceを評価するだけで、実行中プロセスやDBへ接続したり、runtimeの申告が正しいことを証明したりはしません。

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

## License

MIT License

## Disclaimer

本ソフトウェアは安全性を支援するためのツールであり、安全と判定されたコマンド、コード、操作が実際に安全であることを保証するものではありません。

Jevおよび本MCPサーバーの判定結果には、誤検知、見逃し、エラー、不完全な評価が含まれる場合があります。重要な操作や破壊的な操作は、特に本番環境では、実行前に必ずご自身で確認してください。

本ソフトウェアの使用または誤用によって生じたデータ損失、システム障害、サービス中断、セキュリティインシデント、金銭的損失、その他の損害について、著者および貢献者は責任を負いません。

本ソフトウェアは自己責任で使用してください。
