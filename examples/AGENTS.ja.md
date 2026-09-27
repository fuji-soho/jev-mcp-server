## Jev Safety Gate

このプロジェクトでは、破壊的または重大な影響を与える可能性がある操作に対する安全ゲートとして、MCP Server `jev-mcp-server` を使用します。

### コマンド実行

ファイル、Gitリポジトリ、データベース、依存パッケージ、サービス、コンテナ、インフラ、デプロイ、その他の永続的な状態を変更する可能性があるコマンドを実行する前に、必ず以下を呼び出してください。

`jev_check_command`

可能な場合は、実行予定の正確なコマンドとともに以下の情報も渡してください。

- 作業ディレクトリ (`cwd`)
- 環境 (`development`, `testing`, `staging`, `production`, `unknown`)
- 操作対象 (`target`)
- 安全性の判断に必要なその他のコンテキスト

安全チェックを行う際、実際に実行するコマンドを簡略化したり、一部分だけを渡したりしないでください。

### 判定結果の扱い

チェックしたコマンドを実行できるのは、以下をすべて満たす場合のみです。

- `allowed=true`
- `decision=allow`
- `needsHumanReview=false`

以下のいずれかに該当する場合は、コマンドを実行しないでください。

- `decision=review`
- `decision=deny`
- `allowed=false`
- `needsHumanReview=true`

`review` の場合は、検出されたリスクをユーザーへ説明し、明示的な承認を得るまで実行しないでください。

`deny` の場合は実行しないでください。ブロックされた理由を説明し、可能であればより安全な代替手段を提示してください。

### Fail Closed

`jev_check_command` による安全確認が正常に完了しなかった場合、安全だと推測して処理を続行してはいけません。

以下のような場合が該当します。

- MCPを利用できない
- Jev / Cloudflare APIを利用できない
- タイムアウト
- 不正なレスポンス
- Policyの読み込みエラー
- 安全性を判断するための情報不足

これらは人手確認が必要な状態として扱ってください。

`review` または `deny` を回避することだけを目的として、コマンドの表記、Shell構文、実行方法、使用ツールなどを変更して安全ゲートを迂回してはいけません。

### コマンドの同一性

実際に実行するコマンドは、`jev_check_command` が確認したコマンドと実質的に同一でなければなりません。

チェック後に以下のいずれかが変更された場合は、`jev_check_command` を再実行してください。

- コマンド
- 引数
- 操作対象
- 作業ディレクトリ
- 実行環境
- Shell pipeline
- リダイレクト
- その他、実行結果や影響範囲を変更する要素

複合コマンドや以下を含むコマンドでは、その一部分ではなく完全なコマンドを安全チェックへ渡してください。

- `&&`
- `||`
- `;`
- pipe (`|`)
- リダイレクト
- command substitution
- wildcard
- 再帰オプション
- forceオプション

### 読み取り専用操作

永続的な状態を変更しないことが明確な読み取り専用コマンドについては、Jevチェックを省略できます。

例:

- `git status`
- `git diff`
- `pwd`
- `ls`
- ファイル内容の参照
- バージョン確認

読み取り専用かどうか判断できない場合は、`jev_check_command` を使用してください。

### テスト

データベース、ファイルシステム、外部サービス、ネットワーク、credential、本番リソース、その他の永続的な状態へ影響する可能性があるテストコマンドは、言語やフレームワークを問わず `jev_check_test` へ渡して評価してください。フレームワークが分かる場合は、`laravel`、`vitest`、`pytest`、`rspec`、`go`、`cargo` などの `framework` を指定してください。

正確なコマンドに加えて、可能な場合は `cwd`、`environment`、`framework`、`testCode`、`diff`、`context` を渡してください。隔離状態とruntimeアクセスは、次のような構造化情報を優先します。

```json
{
  "command": "npm test",
  "cwd": "/workspace/project",
  "environment": "testing",
  "framework": "vitest",
  "isolation": {
    "temporaryFilesystem": true,
    "mockedExternalServices": true
  },
  "runtime": {
    "productionAccess": false,
    "persistentStorageAccess": false,
    "networkAccess": false
  }
}
```

入力を準備した後、以下の順序で確認してください。

1. テストコード、diff、runtime情報、contextを渡して `jev_check_test` を実行する
2. 実際に実行する完全なテストコマンドを `cwd`・環境情報とともに `jev_check_command` で確認する
3. 両方の結果が、以下をすべて満たす場合のみテストコマンドを実行する

   - `allowed=true`
   - `decision=allow`
   - `needsHumanReview=false`

どちらか一方でも `review`、`deny`、`allowed=false`、`needsHumanReview=true` の場合はテストを実行しないでください。検出された理由を説明し、必要に応じてユーザーへ明示的な判断を求めてください。

Laravelでは `framework` に `laravel` を指定してください。既存の `runtimeDatabase`、`configCache`、`runtimeGuard`、`persistentDatabaseAccess` も引き続き利用できます。`RefreshDatabase`、`DatabaseMigrations`、`DatabaseTruncation`、`migrate:fresh`、`db:wipe`、永続DBのターゲット、テスト設定とruntime設定の不一致は安全性のfindingとして扱ってください。

テスト用設定、`.env.testing`、ドキュメント、環境名などに「テスト環境」と記載されているという理由だけで、環境が安全に分離されていると判断してはいけません。

### Project Policy

`jev-mcp-server` が使用するBuilt-in Policy、User Policy、Project Policyをすべて尊重してください。

プロジェクト固有のルールは、以下のファイルで定義されている場合があります。

`.jev-policy.json`

Project PolicyやUser Policyによって、標準の安全ルールより厳しい制限が設定される場合があります。

より厳しい安全判定を上書き、弱体化、迂回しようとしてはいけません。

### 重要事項

`jev-mcp-server` は追加の安全レイヤーであり、開発者自身による安全確認や判断を置き換えるものではありません。

Jevが `allow` を返した場合でも、本番環境、データ削除、インフラ変更、デプロイ、その他影響の大きい操作については、実行前に対象と予想される影響を別途確認してください。
