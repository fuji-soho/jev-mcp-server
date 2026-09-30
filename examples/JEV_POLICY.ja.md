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

`review` の場合は、検出されたリスクをユーザーへ説明し、明示的な承認を得るまで実行しないでください。`jev_check_command` の判定はこのServerに承認記録を保存しないため、ユーザーの判断後も完全に同じコマンドを再チェックし、`allow` の場合だけ続行してください。

`deny` の場合は実行しないでください。ブロックされた理由を説明し、可能であればより安全な代替手段を提示してください。

### Fail Closed

`jev_check_command` による安全確認が正常に完了しなかった場合、安全だと推測して処理を続行してはいけません。

以下のような場合が該当します。

- MCPを利用できない
- 選択したJev provider API（CloudflareまたはTypeSafe AI）を利用できない
- タイムアウト
- 不正なレスポンス
- Policyの読み込みエラー
- 安全性を判断するための情報不足

これらは人手確認が必要な状態として扱ってください。

障害後にproviderを切り替えたり、存在する認証情報からproviderを推測したり、別provider経由でretryしてはいけません。Static、Built-in、User、Project Policyのいずれかがすでに`deny`を返している場合は、その`deny`を維持します。それ以外のAPI error、認証error、timeout、不正responseは`review`として扱います。過去のHuman Approvalで、現在のJev評価失敗を迂回してはいけません。

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

正確なコマンドに加えて、可能な場合は `cwd`、`environment`、`framework`、`testCode`、`diff`、`context` を渡してください。複数のテストファイルを指定する場合は、対応している `testFiles` を使用してください。各ファイルは個別に評価・キャッシュされるため、独立したテストファイルを1つの巨大な `testCode` にまとめないでください。隔離状態とruntimeアクセスは、次のような構造化情報を優先します。

#### テストパスとコンテナマウント

`cwd` は、`jev-mcp-server` のプロセスがPolicy、Safety Profile、テストファイル、関連ファイルを読み取るためのproject rootです。MCP Serverと同じfilesystem namespaceに実在するディレクトリを指定してください。テスト実行環境内の作業ディレクトリと同じパスであるとは限りません。

コンテナ、VM、remote環境内でテストを実行する場合は、以下に従ってください。

- `command` には、その実行環境内のパスを含む、実際に実行するものと同一のコマンドを指定する
- `cwd` には、対応するhost側、WSL側、またはその他のMCP Serverから参照できるproject rootを指定する
- `testFiles` は、可能な限りその `cwd` からの相対パスで指定する
- MCP Serverが同じコンテナ内で動作していて直接読み取れる場合を除き、コンテナ内だけで有効な絶対パスを `cwd` や `testFiles` に使用しない
- MCP Serverから見えるディレクトリと実行環境内のディレクトリが、同じproject内容を指していることを確認する

たとえば、Podmanがhost側の `/host/projects/app` をコンテナ内の `/app` にmountしている場合は、次のように指定します。

```json
{
  "command": "podman exec app-test sh -lc 'cd /app && composer test'",
  "cwd": "/host/projects/app",
  "framework": "laravel",
  "environment": "testing",
  "testFiles": [
    "tests/Unit/ExampleTest.php",
    "tests/Feature/LoginTest.php"
  ]
}
```

`testFiles` の絶対パスが有効なのは、MCP Serverのfilesystem上で `cwd` の内側に解決される場合だけです。コンテナ内だけで有効なパスを絶対パスにしても、MCP Serverから読み取れるようにはなりません。MCP Serverが指定されたテストファイルを読み取れない場合は、ファイルの説明文で代用せず、審査失敗として扱ってください。

`jev_check_test`が`isError=true`と`TEST_CWD_NOT_FOUND`、`TEST_CWD_NOT_DIRECTORY`、`TEST_CWD_UNREADABLE`、または`TEST_FILE_VALIDATION_ERROR`を返した場合は、Human Reviewを要求せず、テストも実行しないでください。`fileErrors`がある場合はその内容を確認し、MCP Serverから見える`cwd`、mount、またはファイルパスを修正してから`jev_check_test`を再実行してください。これらは承認可能な`reviewId`を持たない入力エラーなので、`jev_review_approve`を呼び出してはいけません。

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

#### テストのHuman Review

`jev_check_test` が `decision=review`、`allowed=false`、`needsHumanReview=true` と `reviewId` を返した場合は、理由と安全性に関係するContextをユーザーへ提示し、明示的な承認を求めてください。ユーザーがそのテストを明示的に承認した場合だけ、返された `reviewId` だけを指定して `jev_review_approve` を呼び出してください。`approved`、`fingerprint`、`command`、`testFiles`、`projectId` などをAI側で追加・生成・書き換えてはいけません。ユーザーが拒否した場合は、必要に応じて同じ `reviewId` を指定して `jev_review_reject` を呼び出してください。

承認後は、同じcommand、テストファイル、作業ディレクトリ、Policy Context、runtime/isolation情報を指定して `jev_check_test` を再実行してください。再チェック結果が `allowed=true`、`decision=allow`、`needsHumanReview=false` の場合のみテストを実行できます。承認はServerが発行したreview、project、command、対象ファイル、Safety Fingerprint、Policy、Safety Profile、runtime Contextに紐付いています。安全性に関係する変更が1つでもあれば過去の承認は無効となり、再審査が必要です。reject済み、期限切れ、存在しない、または別projectのreview IDは使用できません。

Human ApprovalでStatic Check、Jev、Built-in Policy、User Policy、Project Policyの `deny` を覆してはいけません。`jev_review_approve` が成功しただけでテストを実行せず、最終的な `jev_check_test` の判定を必ず確認してください。

Human Reviewの期限は作成時から1時間で、承認によって延長されません。Human Approvalによるallowは再利用可能なallow cacheへ保存しません。承認が必要なチェックではJevを再評価してから、承認の状態・期限・安全Contextの完全一致・APIが返した実modelを照合します。reviewのContextとともに`jevProvider`、`requestedModel`、`actualModel`を人に提示してください。Serverの承認用fingerprintにはコードfingerprint、正確なcommand・対象ファイル・cwdのContext、実modelを含むため、`codeAssessment.fingerprint`と同一視してはいけません。同じ要求aliasでも実modelが変わり、引き続き承認が必要なら新しいHuman Reviewが必要です。期限切れのpending／approved reviewには、新しく発行されたreview IDと新しい明示的承認が必要です。

自動判定のallow cacheを再利用できるのは、実modelと要求modelが一致していた固定TypeSafe modelの`jev-X.Y.Z`だけです。TypeSafeの可変aliasとCloudflareの`typesafe/jev`は、Jev評価が必要な場合に毎回APIを呼び出します。`JEV_MODEL_ID_UNVERIFIED`の場合は停止してください。承認可能な`reviewId`は存在しません。provider／modelの応答を修正して再チェックしてください。API失敗や後続の`deny`を過去の承認で迂回してはいけません。

SQLite schema 6への更新後、旧cacheは再利用不可となり、旧Human Reviewは履歴としてのみ残ります。必要に応じて新しいHuman Reviewの発行と明示的承認を受け、古いreview IDを再利用しようとしないでください。監査履歴と、一致するEnvironment Approvalは保持され、provider／model変更だけではEnvironment Approvalの再承認は不要です。

`jev_check_test` は、変更されていない再利用条件を満たす自動判定のSafety Fingerprint Cache、または実modelに紐付いた有効なHuman Approvalによって `decision=allow` を返すことがあります。この場合も、`allowed` と `needsHumanReview` の確認は省略できません。CacheとHuman Reviewの判定履歴は、ServerのSQLiteへ監査用に保存されます。Cache HITの場合、そのリクエストでJevが呼び出されなかった可能性があります。command、テストファイル、共通の安全Context、Policy、Safety Profile、作業ディレクトリ/project、runtime/isolation情報、evaluator version、Jev provider、要求modelが変化した場合は再利用できず、コードが再評価されます。provider情報を持たない旧cacheは再利用できません。Jev接続用のAPI keyはfingerprintの入力に含めません。

API送信用のマスク結果を入力の同一性とみなしてはいけません。テストファイルは元バイト列のdigestで識別し、インラインの`testCode`、`diff`、`context`、該当するテストcommandはマスク前にハッシュ化します。マスク対象の値だけの変更でも`jev_check_test`を再実行し、APIへ送るマスク済みのテキストが同じという理由でcacheやHuman Approvalを再利用できると判断してはいけません。新しい結果がHuman Reviewを要求する場合は、新しく発行されたreview IDと明示的承認を受けてください。変更を説明するために平文の秘密情報を送信・記録してはいけません。Jev接続用認証情報は引き続き対象外ですが、評価対象のコードやテスト引数内の認証情報はdigestへ影響します。テストコードだけの変更では一致するProfile v2のEnvironment Approvalを維持し、許可されたfilterだけの変更ではコード評価を再利用できます。

`raw-test-input-v1`へのevaluator更新後は、SQLiteがschema 6のままでも旧cacheとHuman Reviewは新しい同一性に一致しません。再チェックし、必要なら新しいHuman Reviewを受け、現在のコードfingerprintに対する新しいExecution Ticketを取得してください。監査履歴と、一致するEnvironment Approvalは保持されます。更新したServerを使用し、古いevaluatorや古いreview／Ticketへ戻して再評価を迂回してはいけません。

Laravelでは `framework` に `laravel` を指定してください。既存の `runtimeDatabase`、`configCache`、`runtimeGuard`、`persistentDatabaseAccess` も引き続き利用できます。`RefreshDatabase`、`DatabaseMigrations`、`DatabaseTruncation`、`migrate:fresh`、`db:wipe`、永続DBのターゲット、テスト設定とruntime設定の不一致は安全性のfindingとして扱ってください。

テスト用設定、`.env.testing`、ドキュメント、環境名などに「テスト環境」と記載されているという理由だけで、環境が安全に分離されていると判断してはいけません。

Safety Profile v2を使用するプロジェクトでは、承認済みrunnerだけを`command`へ指定し、テスト対象は構造化された`execution`で渡してください。`jev_check_test`が`environmentReviewId`を返した場合は、runnerとresource scopeを人に提示し、明示的な承認後に限って`jev_environment_approve`を呼び出します。Environment Approvalはテストコード、Policy finding、Jev findingを承認しません。provider/model変更時はコードを再評価しますが、その変更だけを理由に、一致するEnvironment Approvalを失効させません。

allow結果にExecution Ticketが含まれる場合は、承認済み安全runnerだけを使用します。runnerは実行直前に環境・コード・実行指定のfingerprint、実DB接続、設定キャッシュ、fallback接続、filesystem、networkを再確認してTicketを消費しなければなりません。Ticketをraw commandのshell実行許可として扱ってはいけません。

### Project Policy

`jev-mcp-server` が使用するBuilt-in Policy、User Policy、Project Policyをすべて尊重してください。

プロジェクト固有のルールは、以下のファイルで定義されている場合があります。

`.jev-policy.json`

Project PolicyやUser Policyによって、標準の安全ルールより厳しい制限が設定される場合があります。

より厳しい安全判定を上書き、弱体化、迂回しようとしてはいけません。

### 重要事項

`jev-mcp-server` は追加の安全レイヤーであり、開発者自身による安全確認や判断を置き換えるものではありません。

Jevが `allow` を返した場合でも、本番環境、データ削除、インフラ変更、デプロイ、その他影響の大きい操作については、実行前に対象と予想される影響を別途確認してください。
