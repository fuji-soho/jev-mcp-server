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

`review`の場合は、検出されたリスクをユーザーへ説明してください。`jev_check_command`が`reviewId`を返した場合だけ、人の明示承認後にそのIDだけを`jev_review_approve`へ渡し、完全に同じ内容を再チェックして`allow`の場合だけ続行します。`reviewId`がなければ承認不可なので、不足証拠または障害を修正して再チェックしてください。`review`結果や承認toolの成功応答だけから直接実行してはいけません。

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

Jev中リスク、静的review、実行内容の証拠不足を含め、`jev_check_command`のreview評価が正常完了し、APIがversion付きの実model `jev-X.Y.Z`を返し、review storeが利用可能な場合、1時間有効な`reviewId`を発行できます。正確なcommand、project、environment、target、context、finding、影響、未検証範囲を人に提示します。明示承認後はServer発行IDだけを`jev_review_approve`へ渡し、完全に同じ入力で再チェックします。`allowed=true`、`decision=allow`、`needsHumanReview=false`の場合だけ実行します。再チェックでは毎回Jevを呼びます。承認はraw入力、解決済みproject、現在のPolicy、メッセージを含む静的finding、評価器version、実modelに一致する場合だけ有効で、条件変更時は新しいreviewが必要です。一致する承認は期限まで再利用できます。静的／Jev `deny`、不正入力、Policy／API障害、review store障害、versionなしの実modelは承認・迂回できません。承認はコマンドallow cacheを作成しません。

対応範囲は単純な`ls`、`cat`、`mkdir`、`rmdir`、`touch`、`cp`、`mv`、`rm`、任意の引数が`-L`／`-P`だけの`pwd`、READMEに記載した限定optionの`git status`、記載したoptionと`--`以降のパスを使う`git diff --no-ext-diff --no-textconv`です。tokenはASCII英字・数字と`_./:=+-`だけで、space／tabで区切ります。引用符、escape、改行、shell演算子／展開、wrapper、未知の実行ファイル、非対応のGit option／subcommandはreviewが必要です。この分類はPATH、alias／function、binaryの同一性、fsmonitorを含むGit設定、runtime resourceを検証しません。READMEの正確な対応構文を確認し、似たコマンドから対応を推測しないでください。

スクリプト（`node task.js`、`python task.py`、`./task.sh`）、dispatcher（`npm run`、`make`、`composer run-script`）、`podman exec`や`sh -lc`を含むwrapper、非対応構文では、`staticFindings`に`command.execution-content-unreviewed`を保持します。Serverは本文を読み込まず、依存関係／設定、動的実行、コンテナ内部も解決しません。一致する承認がなければJevが低リスクでもreviewです。今回から、人はこの不確実性を明示的に受け入れ、上記フローで承認できます。allow policyの追加や`context`へのコード／承認申告だけでは承認になりません。承認適用後のallowでもfindingと現在のrisk値を保持し、`approval: { "reviewId": "rev_...", "basis": "human" }`を返します。reasonには適用した承認と実行内容が未検証のままであることを記載します。監査reasonには適用review IDを記録し、監査cache statusは引き続きdisabledです。保持されたreview findingだけを理由に最終allowを停止する必要はありません。review回避だけのためにコマンドを書き換えてはいけません。テストには2回目のcommand checkを加えず既存テスト経路を使います。この変更でテストの証拠不足が承認可能になるわけではありません。

Jevの`dangerous`閾値は変更せず、`0.4`未満はallow、`0.4`以上`0.8`未満はreview、`0.8`以上はdenyとし、より厳しい静的findingを優先します。`riskScore`には静的findingも含み、実行内容の証拠不足だけでも`0.5`になります。承認で数値を下げたり、安全性を保証したりしません。review範囲内の値の変動だけなら再承認は不要です。Pintの`--dirty`は意図したテスト以外の該当dirty PHPファイルも書き換え得ます。`context`の意図した対象は実際の対象を制限しません。

読み取っていないスクリプト本文、依存関係／設定、コンテナ内部はfingerprintに含めず、変更によるコマンド承認失効を自動検出しません。実行入力の変更を把握した場合は、コマンドが同じでも`context`へ変更内容を反映し、新しいreviewを取得します。チェックはファイルをlockせず、実行時の同一性も強制しません。チェックした入力を実行まで維持してください。

移行：旧Serverを停止し、更新後に`npm run build`を実行して再起動し、再チェックしてください。今回のコマンドHuman Review更新はschema 8の`human_reviews`を利用し、DB移行・削除は不要です。評価器versionと静的findingのfingerprint更新により旧コマンド承認は一致しません。Server発行の新しい`reviewId`を取得します。既存の監査／cache履歴とテスト承認は保持します。利用先へコピーした`JEV_POLICY.md`／`JEV_POLICY.ja.md`も更新してください。旧Server、旧Policy、旧結果で現行条件を迂回してはいけません。

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

通常DB経路では`cwd`をホスト上に保ち、人が確認したコンテナのパス対応を登録します。初回登録／承認後は、実際のServer発行条件IDで次のように再チェックします（例のplaceholderを置換してください）。

```json
{
  "command": "podman exec showa-pdoso sh -lc 'cd /var/www/vhosts/kamoi/kamoi-ds && composer test'",
  "cwd": "/var/docker/showa-pdoso/vhosts/kamoi/kamoi-ds",
  "framework": "laravel",
  "environment": "testing",
  "executionConditionsId": "cond_SERVER_ISSUED_ID"
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

1. 正確なcommand、実際の対象ファイル、必要な実行証拠を渡して`jev_check_test`を呼び出す。
2. Server発行の承認可能なreviewだけを、明示的な人の判断後に解消し、再チェックする。
3. `allowed=true`、`decision=allow`、`needsHumanReview=false`が揃う場合だけ同じcommandを実行する。

テスト実行に2回目の`jev_check_command`を追加しません。依存インストール、DB管理、cleanupなど別の操作には使用します。

#### DB登録による実行承認

正確なcommand全体とホストから読めるproject rootを渡し、`jev_check_test`だけを使います。通常のLaravel／Composer／PHP runner経路は構造化`executionConditions`とJevのDBを使い、Profileファイルは不要です。READMEの初回local／Podman／Docker例に従い、`missingFields`の不足項目だけを補完してください。登録エラーを解消するために`.jev/test-safety.json`を作成しません。既存安全runner／接続guardは維持し、Ticket SDKや新しい隔離機構を要求しません。

`executionReviewId`が返ったら、`executionApproval.scope`、登録ID、ホスト／コンテナ対応、正確な入口／固定引数、展開Composer chain、PHP runner全文、guard読込、PHPUnit起動、selector転送、resource／引数範囲を人に提示します。明示承認後だけ、返された`approvalId`だけで`jev_execution_approve`を呼び、再チェックします。pending候補やAI宣言は承認済み登録ではありません。`allowed=true`、`decision=allow`、`needsHumanReview=false`が揃った同じ条件だけを実行します。テスト未実行なら安全審査結果として報告し、テスト成功と混同しません。

次回以降はServer発行`executionConditionsId`で登録を選ぶか、`executionApprovalId`で完全一致する承認を要求できます。実際のcommand／対象も渡し、IDはprojectと現在の条件へ照合されます。複数一致時は`conditionCandidates`を確認して意図したIDを指定し、任意の記録を選びません。scope変更時は古いIDを外して構造化条件を渡し、新登録／reviewを確認します。別コンテナ／scopeは共存できます。approvedに定期失効はなく、pendingは1時間で期限切れになります。`jev_execution_reject`はpending拒否、`jev_execution_revoke`はapproved取消しです。reject／revoke／expired／superseded済みIDは復活せず、承認操作でも証拠を再読込します。

コンテナ方式は人が明示承認した条件を信頼します。上位`cwd`にホストroot、`executionConditions.target`にコンテナ名／projectRoot／workdirを指定します。コンテナworkdirはprojectRoot内に限定し、相対subdirectoryをホストroot内へ対応させます。入口／設定／selectorはworkdir相対、testFilesはホストproject相対です。外側exec対象と内側command全体を照合します。対応は直接`exec --workdir|-w`または`exec name sh -lc 'cd /root && ENTRY'`のcdと1つの入口だけです。追加command、展開、未知exec option、runner迂回では停止します。実行する外側commandを内側Composer commandへ置き換えて審査しません。

inspect、mount／image／container ID追跡、内部collector、MCP移動、コンテナruntime／vendor検査を要求しません。コンテナPHP／Composerをホスト実体として検査しません。同名再作成や内部image／mount変更だけでDB登録更新・再承認を要求しません。`sourceVerification=human-approved-container`、`containerInternalsVerified=false`は人が承認した前提であり、自動検証済みではないと説明します。ローカル直接実行の実行ファイル／runtime／依存検査は維持します。必要なホスト上のソース／guard／設定と現在のコードは、引き続き完全に読み取れる必要があります。

既存runnerは毎回SQLite memoryを強制し、設定cacheを処理・復元し、実接続先を確認して永続／fallback／追加接続を拒否します。宣言、ソース参照、AIの隔離申告だけで強制を証明したと扱いません。初回に既存runnerとguard全文を確認し、新runner SDKを要求しません。

DB実行・明示的な旧Profile v3では、`runner.safetyFiles`に接続guardソースを指定し、PHPUnit XMLや`.env.testing`は`environmentFiles`へ置きます。runner内へのファイル名の直接記載は要求せず、記載を実行の証明にも使いません。guardファイルは引き続き完全・読取可能・通常ファイル・symlinkなしのソースとし、元バイト列で変更検出します。依存メタデータや呼出側の`context`でguardソースを代替してはいけません。実行承認前に、実際のPHPUnit bootstrap、Composerのautoload対応、テスト継承を読み、対象へのguard適用、DB操作より前の実行順序、永続／fallback／追加接続の拒否を確認します。必要なファイルを宣言範囲に含めてください。`runnerVerification.guardLoadingVerified`、`guardApplicabilityVerified`、`resourceIsolationVerified`はすべてfalseであり、構文／ローカルruntime検査をこれらの証明として説明してはいけません。実際の経路やresource保護を確認できなければ承認せず停止します。

`executionApproval.scope.runnerVerification.processInvocations`をrunner全文と照合します。対応する`passthru`は、`escapeshellarg(PHP_BINARY)`と完全一致するliteralなPHPUnit入口または` artisan config:clear`の連結で、selector転送は未変更の`array_slice($argv, 1)`の`foreach`内でspaceと`escapeshellarg`を使います。対応する`proc_open`は固定PHP_BINARYの引数配列を使い、PHPUnitに限り検証済みselector配列を転送します。未対応のcommand構築／alias／scope、生連結、任意command／option、文字列形式の`proc_open`、`eval`、backtick、その他のshell実行関数は、承認不可の`EXECUTION_CHAIN_UNRESOLVED`で停止するため、承認で迂回してはいけません。新規runnerでは引数配列を基本とします。対応構文でも明示的な実行承認と現在のcommand／コード／Policy審査が必要です。終了コード処理、selector制限、キャッシュ復元も確認してください。

`artisan config:clear`はテストguardより前にLaravelを起動します。認識した呼出しでは`artisan`と`bootstrap/app.php`を審査・変更検出に加え、`preparationFiles`へ提示し、欠落・不完全なら停止します。追加の起動／設定依存とテスト前のDB操作・副作用も確認し、`tests/TestCase.php`のguardがこの段階を保護すると推測してはいけません。更新後は依存更新・再build／再起動して再チェックし、verifierの`jev-db-execution-v2`／`jev-test-execution-v2`に従い、見直したscopeへの新しい明示的な実行承認を取得します。以前のコードcache／Human Reviewで新evaluatorを迂回できません。DB schema・入力形式・履歴は保持し、旧v1／v2の挙動は変えません。guard／環境設定を修正して別の登録も一致する場合は、返された`executionConditionsId`を使います。Server更新だけを理由に利用先runnerを書き換えたり、PHPUnitを実行したりしてはいけません。

許可範囲内のテスト追加・本文変更・ファイル／filter変更では一致する実行承認を再利用します。影響するコードと関連コードを審査し、既存の固定modelによる安全なコードcache条件だけを再利用します。通常の関連コード変更はコード審査だけへ影響します。実行定義、runner、guard、bootstrap／安全設定、登録条件、ローカルruntime／依存、Policy変更は実行再承認を要求します。元バイト列・マスク前入力でdigestを計算し、自己申告hashや同じマスク結果を根拠にしません。秘密情報の平文を変更説明や登録／contextログへ保存・提示しません。通常DB登録とコードcache同一性はProfileの未配置・削除・不正な内容に影響されません。

Composerの`--`以降へ許可した相対PHPファイルと1つのliteralな`--filter VALUE`だけを渡します。`testFiles`は実際の対象集合全体と一致させ、全suiteはXMLから解決した全対象を審査します。filterでも選択ファイル全文を審査します。selectorによるPHP option／configuration／bootstrap変更は禁止です。DB経路ではインライン`testCode`と旧`execution`／`environmentApprovalId`を省略します。必要なhelper／applicationソース、安全設定を含め、読込上限回避のためにroot削減・ファイル除外・本文切詰めをしません。Serverは動的PHP import／process全体を解決しません。既存読込／探索／request上限はREADMEを確認してください。

`reviewReasons`を確認します。`execution-approval`は実行承認、`command-risk`／`code-risk`は別の実modelに結び付くHuman Review IDで扱います。`registration-incomplete`、`conditions-ambiguous`、`conditions-mismatch`、`unsupported-form`、`evidence-incomplete`、`evaluation-error`、`approvable=false`は修正が必要です。`missingFields`、`conditionCandidates`、`evidenceErrors`、`fileErrors`の項目／ファイルと対処を確認します。別の承認で残ったエラーは解消しません。静的／Policy／Jevのdeny、未解決review、API／DB／読込失敗を登録やcacheで迂回できません。

承認済み各チェックはコードcache HIT時もcommand全体を毎回Jev評価し、一般コマンドallow cacheは停止したままです。provider／model変更はコード／command審査に影響し、その変更だけで環境承認は失効しません。コードや照合条件が変われば再チェックし、審査した同じcommand／対象だけを実行します。ゲートはOS sandboxやチェックと実行間の変更防止を自動提供しません。

SQLite／WALの整合backupと更新Server／Policyでschema 8へ移行します。旧履歴／cacheは保持し、旧Profile承認をDB承認へ自動変換しません。executionConditionsを渡して新しい初回確認／承認を取得した後、旧Profileを削除できます。明示`safetyProfilePath`で任意のlegacy local v3／v1／v2互換を選び、DB条件／IDと混在させません。旧Profile承認IDを明示pathなしで使う場合は移行が必要です。legacy v2 Ticketは文書化した条件で任意とし、旧Server／evaluator／承認による現行検査の迂回は禁止します。

#### テストのHuman Review

`jev_check_test` が `decision=review`、`allowed=false`、`needsHumanReview=true` と `reviewId` を返した場合は、理由と安全性に関係するContextをユーザーへ提示し、明示的な承認を求めてください。ユーザーがそのテストを明示的に承認した場合だけ、返された `reviewId` だけを指定して `jev_review_approve` を呼び出してください。`approved`、`fingerprint`、`command`、`testFiles`、`projectId` などをAI側で追加・生成・書き換えてはいけません。ユーザーが拒否した場合は、必要に応じて同じ `reviewId` を指定して `jev_review_reject` を呼び出してください。

承認後は、同じcommand、テストファイル、作業ディレクトリ、Policy Context、runtime/isolation情報を指定して `jev_check_test` を再実行してください。再チェック結果が `allowed=true`、`decision=allow`、`needsHumanReview=false` の場合のみテストを実行できます。承認はServerが発行したreview、project、command、対象ファイル、Safety Fingerprint、Policy、Safety Profile、runtime Contextに紐付いています。安全性に関係する変更が1つでもあれば過去の承認は無効となり、再審査が必要です。reject済み、期限切れ、存在しない、または別projectのreview IDは使用できません。

Human ApprovalでStatic Check、Jev、Built-in Policy、User Policy、Project Policyの `deny` を覆してはいけません。`jev_review_approve` が成功しただけでテストを実行せず、最終的な `jev_check_test` の判定を必ず確認してください。

Human Reviewの期限は作成時から1時間で、承認によって延長されません。Human Approvalによるallowは再利用可能なallow cacheへ保存しません。承認が必要なチェックではJevを再評価してから、承認の状態・期限・安全Contextの完全一致・APIが返した実modelを照合します。reviewのContextとともに`jevProvider`、`requestedModel`、`actualModel`を人に提示してください。Serverの承認用fingerprintにはコードfingerprint、正確なcommand・対象ファイル・cwdのContext、実modelを含むため、`codeAssessment.fingerprint`と同一視してはいけません。同じ要求aliasでも実modelが変わり、引き続き承認が必要なら新しいHuman Reviewが必要です。期限切れのpending／approved reviewには、新しく発行されたreview IDと新しい明示的承認が必要です。

`jev_check_test`で自動判定のallow cacheを再利用できるのは、実modelと要求modelが一致していた固定TypeSafe modelの`jev-X.Y.Z`だけです。TypeSafeの可変aliasとCloudflareの`typesafe/jev`は、Jev評価が必要な場合に毎回APIを呼び出します。`JEV_MODEL_ID_UNVERIFIED`の場合は停止してください。承認可能な`reviewId`は存在しません。provider／modelの応答を修正して再チェックしてください。API失敗や後続の`deny`を過去の承認で迂回してはいけません。

SQLite schema 6への更新後、旧cacheは再利用不可となり、旧Human Reviewは履歴としてのみ残ります。必要に応じて新しいHuman Reviewの発行と明示的承認を受け、古いreview IDを再利用しようとしないでください。監査履歴と、一致するEnvironment Approvalは保持され、provider／model変更だけではEnvironment Approvalの再承認は不要です。

`jev_check_test` は、変更されていない再利用条件を満たす自動判定のSafety Fingerprint Cache、または実modelに紐付いた有効なHuman Approvalによって `decision=allow` を返すことがあります。この場合も、`allowed` と `needsHumanReview` の確認は省略できません。CacheとHuman Reviewの判定履歴は、ServerのSQLiteへ監査用に保存されます。コードCache HITの場合、そのコードはJevへ再送されなかった可能性がありますが、DB登録とlegacy Profile v3のcommandは引き続きJevで評価します。command、テストファイル、共通の安全Context、Policy、Safety Profile、作業ディレクトリ/project、runtime/isolation情報、evaluator version、Jev provider、要求modelが変化した場合は再利用できず、コードが再評価されます。provider情報を持たない旧cacheは再利用できません。Jev接続用のAPI keyはfingerprintの入力に含めません。

API送信用のマスク結果を入力の同一性とみなしてはいけません。テストファイルは元バイト列のdigestで識別し、インラインの`testCode`、`diff`、`context`、該当するテストcommandはマスク前にハッシュ化します。マスク対象の値だけの変更でも`jev_check_test`を再実行し、APIへ送るマスク済みのテキストが同じという理由でcacheやHuman Approvalを再利用できると判断してはいけません。新しい結果がHuman Reviewを要求する場合は、新しく発行されたreview IDと明示的承認を受けてください。変更を説明するために平文の秘密情報を送信・記録してはいけません。Jev接続用認証情報は引き続き対象外ですが、評価対象のコードやテスト引数内の認証情報はdigestへ影響します。テストコードだけの変更では一致するProfile v2のEnvironment Approvalを維持し、許可されたfilterだけの変更ではコード評価を再利用できます。

`raw-test-input-v1`へのevaluator更新後は、その更新自体はDB schemaを変更しなくても旧cacheとHuman Reviewは新しい同一性に一致しません。再チェックし、必要なら新しいHuman Reviewを受け、任意のProfile v2 Ticket経路を使う場合だけ現在のコードfingerprintに対する新しいExecution Ticketを取得してください。監査履歴と、一致するEnvironment Approvalは保持されます。更新したServerを使用し、古いevaluatorや古いreview／Ticketへ戻して再評価を迂回してはいけません。

Laravelでは `framework` に `laravel` を指定してください。既存の `runtimeDatabase`、`configCache`、`runtimeGuard`、`persistentDatabaseAccess` も引き続き利用できます。`RefreshDatabase`、`DatabaseMigrations`、`DatabaseTruncation`、`migrate:fresh`、`db:wipe`、永続DBのターゲット、テスト設定とruntime設定の不一致は安全性のfindingとして扱ってください。

テスト用設定、`.env.testing`、ドキュメント、環境名などに「テスト環境」と記載されているという理由だけで、環境が安全に分離されていると判断してはいけません。

Safety Profile v2を使用するプロジェクトでは、承認済みrunnerだけを`command`へ指定し、テスト対象は構造化された`execution`で渡してください。`jev_check_test`が`environmentReviewId`を返した場合は、runnerとresource scopeを人に提示し、明示的な承認後に限って`jev_environment_approve`を呼び出します。Environment Approvalはテストコード、Policy finding、Jev findingを承認しません。provider/model変更時はコードを再評価しますが、その変更だけを理由に、一致するEnvironment Approvalを失効させません。

DB登録条件・旧Profileのどちらでも、`composer.lock`はJSONテキストですが、全文は依存メタデータとして扱い、ソース審査へ提出しません。この名前と完全一致する通常ファイル（入れ子のパスを含む）は、明示指定・`codeReviewRoots`配下の探索のどちらでも、Jevへ送るcommand証拠本文と`relatedCode`から除外します。変更検出にはproject相対パス・元バイト列のSHA-256 digest・byte数だけを保持します。

ソースの64ファイル／1件32 KiB／合計1024 KiB上限には算入せず、メタデータは別枠で64ファイル／1件8 MiB、探索4096 entryは共通です。存在しない／読めないファイル、symlink、通常ファイル以外では引き続き停止します。他のlockfileにはこの除外を適用しません。ローカルのComposer plugin検査はJSONをローカルで読み続けますが、コンテナ内部の検査は行いません。`testFiles`での`composer.lock`提出も禁止します（`TEST_FILE_METADATA_ONLY`）。

これを含む既存DB登録・旧Profileの設定変更は不要です。lock変更は該当するコード審査の同一性を失効させ、実行条件または自動依存検出に含まれる場合は実行再承認が必要です。更新後は再build／再起動して再チェックしてください。`related-code-v2`によりDB schemaを変えずに以前のコードcache／Human Reviewを失効させますが、一致する実行承認・環境承認は保持します。

Profile v2では、関連するhelper・setup・applicationコードが`codeReviewRoots`の範囲に含まれることを確認してください。Serverはメタデータ専用の`composer.lock`を除くソースについて、manifestやdiffだけでなく現在の全文を検査し、1リクエスト内の全テストで重複排除した同一スナップショットを使います。平文にBuilt-in／User／Project Policyとframeworkの静的検査を適用し、マスクした`relatedCode`（`file`、`content`）をJevへ送ります。関連findingにはproject相対パスの`file`が付く場合があります。元バイト列の変更・追加・削除は対応するコードcacheとHuman Approvalを失効させるため、マスク済み本文が同じという理由で同一性を推測してはいけません。平文の本文はSQLite・ログ・MCP結果へ残しません。マスクはbest effortなので、範囲内の機密情報も別途確認してください。

snapshotの読込上限1024 KiBと、完成したコード審査リクエストのJSON上限256 KiBは別です。読込可能でも送信容量超過なら停止し、自動分割・切り詰めは行いません。

上限は関連ファイル64件、1ファイル32 KiB、元バイト列の合計1024 KiB、ディレクトリを含む探索entry 4096件、完成したJevリクエストのJSON全体256 KiBです。存在しない／読めないパス、親または末端のsymlink、通常ファイル以外、binary／非UTF-8、上限超過では`RELATED_CODE_REVIEW_INCOMPLETE`、`decision=review`、`allowed=false`となります。承認可能な`reviewId`とExecution Ticketはないので停止してください。`jev_review_approve`、過去の承認／cacheの再利用、本文の切り詰め、拡張子による除外、必要なrootの削除で迂回してはいけません。理由を説明し、読み取り可否・範囲・リクエスト容量を修正して再チェックします。検出済みの静的`deny`は維持します。関連コードの審査失敗だけでは一致するEnvironment Approvalを取り消しません。

範囲は指定テストと明示した`codeReviewRoots`だけで、Serverはimport・package・動的依存を自動解決しません。空のroot一覧は追加審査の指定がないという意味であり、依存全体の安全性の証明ではありません。大きなソースディレクトリは上限を超える場合があります。`composer.lock`には別枠のメタデータ上限を適用します。`related-code-v2`へのevaluator更新はその更新自体ではDB schemaを変更せずに以前のコードcache／Human Reviewを失効させます。更新済みServerで再評価し、必要なら新しい明示的なHuman Approvalを取得し、任意のProfile v2 Ticket経路を使う場合だけ新しいExecution Ticketを取得してください。履歴と、一致するEnvironment Approvalは保持します。古いevaluatorやreview／Ticketへ戻して審査を回避してはいけません。

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
