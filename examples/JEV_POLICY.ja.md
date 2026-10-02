## Jev Safety Gate

このプロジェクトでは、破壊的または重大な影響を与える可能性がある操作に対する安全ゲートとして、MCP Server `jev-mcp-server` を使用します。

### コマンド実行

テスト実行は後述のテスト手順で`jev_check_test`だけを使います。それ以外の、ファイル、Gitリポジトリ、データベース、依存パッケージ、サービス、コンテナ、インフラ、デプロイ、その他の永続的な状態を変更する可能性があるコマンドを実行する前に、必ず以下を呼び出してください。

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

### コマンドの審査範囲とキャッシュ

`jev_check_command`は、provider／modelによらずallow cacheを再利用しません。入力とPolicyの検証に成功し、静的`deny`のないチェックでは、毎回Jevを評価します。旧コマンドcacheは履歴としてのみ扱い、テストのcache動作は変更しません。

対応範囲は単純な`ls`、`cat`、`mkdir`、`rmdir`、`touch`、`cp`、`mv`、`rm`、任意の引数が`-L`／`-P`だけの`pwd`、READMEに記載した限定optionの`git status`、記載したoptionと`--`以降のパスを使う`git diff --no-ext-diff --no-textconv`です。tokenはASCII英字・数字と`_./:=+-`だけで、space／tabで区切ります。引用符、escape、改行、shell演算子／展開、wrapper、未知の実行ファイル、非対応のGit option／subcommandはreviewが必要です。この分類はPATH、alias／function、binaryの同一性、fsmonitorを含むGit設定、runtime resourceを検証しません。READMEの正確な対応構文を確認し、似たコマンドから対応を推測しないでください。

`staticFindings`に`command.execution-content-unreviewed`がある場合は停止してください。スクリプト本文、依存関係／設定の内容、動的な実行内容は審査されていません。`node task.js`、`python task.py`、`./task.sh`などのスクリプトや、`npm run`、`make`、`composer run-script`などのdispatcherは、Jevが低リスクでも`review`のままです。コマンド用の`reviewId`は発行しません。`jev_review_approve`の呼び出し、allow policyの追加、`context`へのコード／承認申告の追加、人の承認だけで内容不足を解除してはいけません。このリリースでは、同じ非対応コマンドを繰り返しても自動承認されないことを説明してください。静的検査／Jevの`deny`は優先します。この条件を回避することだけを目的としてコマンドを簡略化・書き換えてはいけません。

コマンド文字列が同じでも、スクリプト本文、関連設定／依存関係、その他の実行入力が変われば再チェックしてください。チェックはファイルをlockせず、実行時の同一性も強制しません。チェックした入力を実行まで維持してください。

`command-scope-v1:no-command-cache-v1`への更新では、旧Serverのプロセスを停止し、更新済みServerを再build／再起動して再チェックしてください。SQLiteはschema 6のままで、このコマンド専用更新により履歴や、既存テストcache／Human Review／Environment Approval／Execution Ticketの動作は変更しません。旧Serverや旧コマンドallowで新しいreview条件を迂回してはいけません。

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

Profile v3ではwrapper／コンテナcommandは未対応です。MCP processもテスト用コンテナ内で動き、Podmanがprojectを`/app`へmountしている場合、同じnamespaceで直接実行するcommandを確認します。

```json
{
  "command": "composer test",
  "cwd": "/app",
  "framework": "laravel",
  "environment": "testing",
  "testFiles": ["tests/Unit/ExampleTest.php", "tests/Feature/LoginTest.php"]
}
```

このファイル一覧はcommandから解決したsuite／選択集合の全体でなければなりません。別namespaceから実行するwrapper commandを、この内側のcommandへ置き換えて審査してはいけません。

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

1. 正確なcommand、実際の対象ファイル、必要な実行証拠を渡して`jev_check_test`を呼び出す。
2. Server発行の承認可能なreviewだけを、明示的な人の判断後に解消し、再チェックする。
3. `allowed=true`、`decision=allow`、`needsHumanReview=false`が揃う場合だけ同じcommandを実行する。

テスト実行に2回目の`jev_check_command`を追加しません。依存インストール、DB管理、cleanupなど別の操作には使用します。

#### Profile v3の実行承認

通常の確認済みLaravel／Composer経路は、`.jev/test-safety.json`のversion 3と既存のPHP安全runnerを使います。READMEの完全なschemaとruntime条件に従い、MCPから参照できる`cwd`、`framework=laravel`、`environment=testing`、正確なローカルcommandを渡します。Composerテストはv3を要求します。未対応を避けるためにwrapper／コンテナcommandを内側の`composer test`へ置き換えてはいけません。初期v3対応ではMCPと実行を同じPOSIXローカルnamespaceで行います。

`executionReviewId`が返った場合は、`executionApproval.scope`のcommand・展開したComposer chain全文・PHP runner・guardファイル・runtime設定・許可resource／引数範囲を人に提示します。人はrunner全文、guard読込、PHPUnit起動、selector転送を確認します。script名、ソース内の参照、申告hash、profile宣言、「SQLiteで隔離済み」という申告だけでは安全性を証明しません。明示的承認後だけ、返された`approvalId`だけで`jev_execution_approve`を呼び、再チェックします。承認操作だけでは実行できません。

approved実行承認に定期失効はなく、pending reviewは1時間で期限切れになります。`jev_execution_reject`はpendingを拒否、`jev_execution_revoke`はapprovedを取消し、いずれも`approvalId`だけを受け取ります。reject／revoke／superseded済みIDは復活しません。`executionApprovalId`はその有効な承認との完全一致が必要な場合だけ使い、IDを生成・差し替えないでください。承認待ちの条件変更には新しいreviewが必要です。v3履歴のあるprojectでprofileを削除・downgradeしてlegacy承認へ戻してはいけません。

許可範囲内のテスト追加・本文変更、filter／file選択変更では実行再承認は不要ですが、現在のコード審査または条件を満たすコードcacheが必要です。通常の関連コード変更は依存するコード審査を失効させ、runner・guard・環境／安全ファイル・実行ファイル／runtime同一性・Composer定義／autoload／依存・profile scope・適用Policyの変更は実行再承認を要求します。provider／model変更はコード審査だけへ影響します。SHA-256は元バイト列とマスク前入力から作り、同じマスク結果を同一性の根拠にしません。変更説明のために秘密情報の値を送信・保存しないでください。

Serverは実行定義、宣言した安全ファイル、XML bootstrap、インストール済みvendor依存、Composer／global metadata、安全設定を読み込み・照合します。有効なPHP設定をすべて宣言し、実際の実行も同じ設定を使うことを確認します。`runtime.configFiles: []`は人が確認した不在の宣言であり、自動検出ではありません。Serverは任意のPHP importや動的subprocess全体を解決しません。必要なhelper／applicationソースが`codeReviewRoots`に含まれることを確認し、停止回避のために範囲を縮小しないでください。

許可済みPHPファイルselectorと、許可された1つの`--filter VALUE`だけを渡します。selector許可の下でconfiguration／bootstrap／PHP optionを変更してはいけません。`testFiles`はcommandの全対象集合と一致させます。全suite commandはXMLから列挙したsuite全体の審査が必要で、一部だけを渡してはいけません。filterだけでも対象ファイル全体を審査します。インライン`testCode`とv2の`execution`／`environmentApprovalId`はv3へ混在できません。対応script参照、plugin無効化、runtimeパス、読込／探索上限はREADMEを確認してください。

`reviewReasons`を確認します。`execution-approval`は実行条件reviewだけ、`command-risk`／`code-risk`はそれぞれ実modelに結び付くHuman Review IDで扱います。`evidence-incomplete`／`evaluation-error`、`approvable=false`、未対応形式、対象／scope不一致、読めない／不足したファイル・設定、symlink、上限超過は修正して再チェックします。それらのエラーを承認したり、過去の承認／cacheで迂回したりしてはいけません。別の有効なreview IDでも未解決の理由は解消しません。静的検査／Policy／Jevのdenyは常に優先します。

承認済みv3の各チェックはコードcache HIT時もcommandを毎回Jevへ評価させ、コマンドallow cacheは引き続き無効です。自動コードcacheは既存の固定model／実model条件を維持します。必要なAPI評価の失敗を実行承認や過去のHuman Reviewで解除できません。最終のテストゲートが3つのallow条件を満たす場合だけ実行します。

通常経路にExecution TicketやTicket SDKは不要です。確認済みの既存runnerが毎回SQLite memoryの強制、実DB接続確認、永続／fallback／追加接続拒否、config cacheの処理を行います。command、対象、コード、安全条件の変更は再チェックします。ゲートはOS sandbox、lock、チェックから実行までの競合防止を自動提供しません。

schema 7への更新後は、更新したServerと配布Policyを使い、初回のv3実行承認を取得してください。既存の30日期限Environment Approvalを無期限承認へ変換しません。任意の従来v1／v2経路とv2 Ticketはその文書化した条件だけで維持し、現行チェックを回避するためのprofile／Server downgradeや旧記録の再利用は禁止します。

#### テストのHuman Review

`jev_check_test` が `decision=review`、`allowed=false`、`needsHumanReview=true` と `reviewId` を返した場合は、理由と安全性に関係するContextをユーザーへ提示し、明示的な承認を求めてください。ユーザーがそのテストを明示的に承認した場合だけ、返された `reviewId` だけを指定して `jev_review_approve` を呼び出してください。`approved`、`fingerprint`、`command`、`testFiles`、`projectId` などをAI側で追加・生成・書き換えてはいけません。ユーザーが拒否した場合は、必要に応じて同じ `reviewId` を指定して `jev_review_reject` を呼び出してください。

承認後は、同じcommand、テストファイル、作業ディレクトリ、Policy Context、runtime/isolation情報を指定して `jev_check_test` を再実行してください。再チェック結果が `allowed=true`、`decision=allow`、`needsHumanReview=false` の場合のみテストを実行できます。承認はServerが発行したreview、project、command、対象ファイル、Safety Fingerprint、Policy、Safety Profile、runtime Contextに紐付いています。安全性に関係する変更が1つでもあれば過去の承認は無効となり、再審査が必要です。reject済み、期限切れ、存在しない、または別projectのreview IDは使用できません。

Human ApprovalでStatic Check、Jev、Built-in Policy、User Policy、Project Policyの `deny` を覆してはいけません。`jev_review_approve` が成功しただけでテストを実行せず、最終的な `jev_check_test` の判定を必ず確認してください。

Human Reviewの期限は作成時から1時間で、承認によって延長されません。Human Approvalによるallowは再利用可能なallow cacheへ保存しません。承認が必要なチェックではJevを再評価してから、承認の状態・期限・安全Contextの完全一致・APIが返した実modelを照合します。reviewのContextとともに`jevProvider`、`requestedModel`、`actualModel`を人に提示してください。Serverの承認用fingerprintにはコードfingerprint、正確なcommand・対象ファイル・cwdのContext、実modelを含むため、`codeAssessment.fingerprint`と同一視してはいけません。同じ要求aliasでも実modelが変わり、引き続き承認が必要なら新しいHuman Reviewが必要です。期限切れのpending／approved reviewには、新しく発行されたreview IDと新しい明示的承認が必要です。

`jev_check_test`で自動判定のallow cacheを再利用できるのは、実modelと要求modelが一致していた固定TypeSafe modelの`jev-X.Y.Z`だけです。TypeSafeの可変aliasとCloudflareの`typesafe/jev`は、Jev評価が必要な場合に毎回APIを呼び出します。`JEV_MODEL_ID_UNVERIFIED`の場合は停止してください。承認可能な`reviewId`は存在しません。provider／modelの応答を修正して再チェックしてください。API失敗や後続の`deny`を過去の承認で迂回してはいけません。

SQLite schema 6への更新後、旧cacheは再利用不可となり、旧Human Reviewは履歴としてのみ残ります。必要に応じて新しいHuman Reviewの発行と明示的承認を受け、古いreview IDを再利用しようとしないでください。監査履歴と、一致するEnvironment Approvalは保持され、provider／model変更だけではEnvironment Approvalの再承認は不要です。

`jev_check_test` は、変更されていない再利用条件を満たす自動判定のSafety Fingerprint Cache、または実modelに紐付いた有効なHuman Approvalによって `decision=allow` を返すことがあります。この場合も、`allowed` と `needsHumanReview` の確認は省略できません。CacheとHuman Reviewの判定履歴は、ServerのSQLiteへ監査用に保存されます。コードCache HITの場合、そのコードはJevへ再送されなかった可能性がありますが、Profile v3のcommandは引き続きJevで評価します。command、テストファイル、共通の安全Context、Policy、Safety Profile、作業ディレクトリ/project、runtime/isolation情報、evaluator version、Jev provider、要求modelが変化した場合は再利用できず、コードが再評価されます。provider情報を持たない旧cacheは再利用できません。Jev接続用のAPI keyはfingerprintの入力に含めません。

API送信用のマスク結果を入力の同一性とみなしてはいけません。テストファイルは元バイト列のdigestで識別し、インラインの`testCode`、`diff`、`context`、該当するテストcommandはマスク前にハッシュ化します。マスク対象の値だけの変更でも`jev_check_test`を再実行し、APIへ送るマスク済みのテキストが同じという理由でcacheやHuman Approvalを再利用できると判断してはいけません。新しい結果がHuman Reviewを要求する場合は、新しく発行されたreview IDと明示的承認を受けてください。変更を説明するために平文の秘密情報を送信・記録してはいけません。Jev接続用認証情報は引き続き対象外ですが、評価対象のコードやテスト引数内の認証情報はdigestへ影響します。テストコードだけの変更では一致するProfile v2のEnvironment Approvalを維持し、許可されたfilterだけの変更ではコード評価を再利用できます。

`raw-test-input-v1`へのevaluator更新後は、その更新自体はDB schemaを変更しなくても旧cacheとHuman Reviewは新しい同一性に一致しません。再チェックし、必要なら新しいHuman Reviewを受け、任意のProfile v2 Ticket経路を使う場合だけ現在のコードfingerprintに対する新しいExecution Ticketを取得してください。監査履歴と、一致するEnvironment Approvalは保持されます。更新したServerを使用し、古いevaluatorや古いreview／Ticketへ戻して再評価を迂回してはいけません。

Laravelでは `framework` に `laravel` を指定してください。既存の `runtimeDatabase`、`configCache`、`runtimeGuard`、`persistentDatabaseAccess` も引き続き利用できます。`RefreshDatabase`、`DatabaseMigrations`、`DatabaseTruncation`、`migrate:fresh`、`db:wipe`、永続DBのターゲット、テスト設定とruntime設定の不一致は安全性のfindingとして扱ってください。

テスト用設定、`.env.testing`、ドキュメント、環境名などに「テスト環境」と記載されているという理由だけで、環境が安全に分離されていると判断してはいけません。

Safety Profile v2を使用するプロジェクトでは、承認済みrunnerだけを`command`へ指定し、テスト対象は構造化された`execution`で渡してください。`jev_check_test`が`environmentReviewId`を返した場合は、runnerとresource scopeを人に提示し、明示的な承認後に限って`jev_environment_approve`を呼び出します。Environment Approvalはテストコード、Policy finding、Jev findingを承認しません。provider/model変更時はコードを再評価しますが、その変更だけを理由に、一致するEnvironment Approvalを失効させません。

Profile v2では、関連するhelper・setup・applicationコードが`codeReviewRoots`の範囲に含まれることを確認してください。Serverはmanifestやdiffだけでなく現在の全文を検査し、1リクエスト内の全テストで重複排除した同一スナップショットを使います。平文にBuilt-in／User／Project Policyとframeworkの静的検査を適用し、マスクした`relatedCode`（`file`、`content`）をJevへ送ります。関連findingにはproject相対パスの`file`が付く場合があります。元バイト列の変更・追加・削除は対応するコードcacheとHuman Approvalを失効させるため、マスク済み本文が同じという理由で同一性を推測してはいけません。平文の本文はSQLite・ログ・MCP結果へ残しません。マスクはbest effortなので、範囲内の機密情報も別途確認してください。

上限は関連ファイル64件、1ファイル32 KiB、元バイト列の合計64 KiB、ディレクトリを含む探索entry 4096件、完成したJevリクエストのJSON全体256 KiBです。存在しない／読めないパス、親または末端のsymlink、通常ファイル以外、binary／非UTF-8、上限超過では`RELATED_CODE_REVIEW_INCOMPLETE`、`decision=review`、`allowed=false`となります。承認可能な`reviewId`とExecution Ticketはないので停止してください。`jev_review_approve`、過去の承認／cacheの再利用、本文の切り詰め、拡張子による除外、必要なrootの削除で迂回してはいけません。理由を説明し、読み取り可否・範囲・リクエスト容量を修正して再チェックします。検出済みの静的`deny`は維持します。関連コードの審査失敗だけでは一致するEnvironment Approvalを取り消しません。

範囲は指定テストと明示した`codeReviewRoots`だけで、Serverはimport・package・動的依存を自動解決しません。空のroot一覧は追加審査の指定がないという意味であり、依存全体の安全性の証明ではありません。大きなディレクトリやlockfileは上限を超える場合があります。`related-code-v1`へのevaluator更新はその更新自体ではDB schemaを変更せずに以前のコードcache／Human Reviewを失効させます。更新済みServerで再評価し、必要なら新しい明示的なHuman Approvalを取得し、任意のProfile v2 Ticket経路を使う場合だけ新しいExecution Ticketを取得してください。履歴と、一致するEnvironment Approvalは保持します。古いevaluatorやreview／Ticketへ戻して審査を回避してはいけません。

任意の従来Profile v2 Ticket経路を明示的に選び、allow結果にExecution Ticketが含まれる場合だけ、その承認済み安全runnerを使用します。runnerは実行直前に環境・コード・実行指定のfingerprint、実DB接続、設定キャッシュ、fallback・追加接続、filesystem、network、credentialを再確認してTicketを消費しなければなりません。コード審査は実際のruntime resourceやfallbackアクセスの不存在を証明しません。Ticketをraw commandのshell実行許可として扱ってはいけません。

### Project Policy

`jev-mcp-server` が使用するBuilt-in Policy、User Policy、Project Policyをすべて尊重してください。

プロジェクト固有のルールは、以下のファイルで定義されている場合があります。

`.jev-policy.json`

Project PolicyやUser Policyによって、標準の安全ルールより厳しい制限が設定される場合があります。

より厳しい安全判定を上書き、弱体化、迂回しようとしてはいけません。

### 重要事項

`jev-mcp-server` は追加の安全レイヤーであり、開発者自身による安全確認や判断を置き換えるものではありません。

Jevが `allow` を返した場合でも、本番環境、データ削除、インフラ変更、デプロイ、その他影響の大きい操作については、実行前に対象と予想される影響を別途確認してください。
