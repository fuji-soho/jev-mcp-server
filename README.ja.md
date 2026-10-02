# jev-mcp-server

Cloudflare経由またはTypeSafe AI公式APIへの直接接続でJevを利用し、ローカルの静的ポリシーと組み合わせる、AI coding agent向けの読み取り専用MCP安全ゲートです。コマンドやテストを実行せず、実行前の `allow` / `review` / `deny` 判定だけを返します。

## セットアップ

```sh
npm install
npm run build
```

認証情報はリポジトリへ保存しません。

リポジトリ直下に `/jev-mcp-server/.env` ファイルを作成し、接続先を1つ選択してください。TypeSafe AI公式APIへ直接接続する場合：

```dotenv
JEV_PROVIDER=typesafe
TYPESAFE_API_KEY=your-typesafe-api-key
TYPESAFE_MODEL=jev-1.13.0
```

`TYPESAFE_MODEL`の既定値は固定リリース`jev-1.13.0`です。従来のCloudflare経由を利用する場合：

```dotenv
JEV_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

`JEV_PROVIDER`の既定値は`cloudflare`なので、既存のCloudflare設定ファイルに移行作業は不要です。未知のproviderは設定エラーになり、選択したproviderの認証情報だけが必須です。認証情報の有無からproviderを推測せず、障害時に別providerへ自動切替もしません。

再現可能な安全判定のため、TypeSafe modelはversion付きIDへ固定することを推奨します。`jev-latest`や`jev-preview`などの可変aliasも利用できますが、設定変更なしで実モデルが変わり得るため、そのallow判定はSafety Fingerprint Cacheから再利用しません。応答の`jevProvider`、`requestedModel`、`actualModel`で、選択したprovider、設定したmodel、APIが返した実modelを区別できます。

Cloudflareの`typesafe/jev`も可変modelとして扱い、Jev評価が必要なチェックでは毎回APIを呼び出します。`jev_check_test`で自動判定のallowを再利用できるのは、固定したTypeSafeの`jev-X.Y.Z`で、APIが返した実modelと要求modelが一致していた場合だけです。Human Approvalによるallowは再利用可能なallow cacheへ保存しません。

直接接続のendpointと現在利用できるmodel IDは、TypeSafe AI公式の[API reference](https://docs.typesafe.ai/api)と[model list](https://docs.typesafe.ai/models)を参照してください。

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

結果には後方互換用の`dangerous`と`model`に加え、`riskScore`、`categories`、カテゴリ別`risks`、`staticFindings`、該当する場合は`jevProvider`、`requestedModel`、`actualModel`が含まれます。`allowed=false`は実行許可を意味しません。

組み込みポリシーは [`policies/default.json`](policies/default.json) にあり、filesystem、Git、DB、コンテナ、サービス、deployment、package管理などを対象にします。静的に明確なdenyとなる操作は、Jevが低リスクを返しても許可されません。

### コマンドの審査範囲とキャッシュ

`jev_check_command`は、固定TypeSafe modelの場合も含め、再利用可能なallow cacheを読み書きしません。入力とPolicyの検証に成功し、静的`deny`のないチェックでは、毎回Jevを呼び出します。旧コマンドcacheは参照せず履歴として保持し、監査記録には`cacheStatus=disabled`を記録します。テストのcache動作は変更しません。

対応する直接コマンドの構文は、次に限定します。

- `ls`、`cat`、`mkdir`、`rmdir`、`touch`、`cp`、`mv`、`rm`。引数も以下の構文に従います。
- `pwd`。任意の引数は`-L`または`-P`だけです。
- `git status`。任意の引数は`--short`, `-s`, `--branch`, `-b`, `--show-stash`, `--porcelain`, `--porcelain=v1`, `--porcelain=v2`, `--long`, `--untracked-files`, `--untracked-files=no`, `--untracked-files=normal`, `--untracked-files=all`, `--ignored`, `--ignored=traditional`, `--ignored=matching`, `--ignored=no`だけです。
- `git diff`。`--no-ext-diff`と`--no-textconv`の両方が必須です。任意の`--`より前では、この2つと`--stat`、`--name-only`、`--name-status`、`--cached`、`--staged`だけに対応し、パスは`--`の後に指定できます。

tokenに使える文字はASCII英字・数字、`_`、`.`、`/`、`:`、`=`、`+`、`-`だけで、spaceまたはtabで区切ります。先頭・末尾のspaceとtabも許容します。実行ファイル名は上記の名前との完全一致が必要です。引用符、escape、改行、置換、展開、pipeline、redirect、複合コマンド、wrapper、その他のGit option／subcommand、未知の実行ファイルは対象外です。構文一致は毎回の静的検査・Jev評価の対象になるだけで、自動的なallowを意味しません。実行ファイルの解決、PATH、alias／function、インストール済みbinaryの同一性、fsmonitorを含むGit設定、runtime resourceは監査しません。

スクリプト（`node task.js`、`python task.py`、`./task.sh`）、dispatcher（`npm run`、`make`、`composer run-script`）、wrapper、その他の非対応構文は、`staticFindings`に`command.execution-content-unreviewed`を追加します。Serverは本文を読み込まず、依存関係・設定も解決しません。Jevが低リスクでも最低限`decision=review`、`allowed=false`、`needsHumanReview=true`を返し、静的検査またはJevの`deny`は優先します。`context`へコードや承認の申告を追加したり、allow policyを設定したりしても、このfindingは解除されません。コマンドチェックでは`reviewId`を発行せず、`jev_review_approve`や人の承認だけで実行内容の不足を解除することもできません。同じ非対応コマンドの再チェックは引き続き`review`となり、このリリースではスクリプトの自動承認を提供しません。

移行：旧Serverのプロセスを停止し、更新後に`npm run build`を実行して再起動し、実行前に再チェックしてください。コマンド用evaluatorに`command-scope-v1:no-command-cache-v1`を追加します。この以前のコマンド専用更新自体にはDB移行・削除は不要でした。現行リリースは後述のschema 7へ移行します。このコマンド専用の更新によって、既存の監査／cache履歴、テストcache、テストのHuman Review、一致するEnvironment Approval、テストのExecution Ticketは失効しません。旧Serverは旧コマンドcacheを再利用できるため、同じcacheとの併用や、reviewを迂回するためのダウングレードは行わないでください。

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

評価が正常に完了してHuman Approvalが必要となり、version付きの実modelを識別できた場合、Serverは短時間だけ有効なHuman Reviewを保存し、`decision=review`と`reviewId`を返します。人間が明示的に承認した後は、`jev_review_approve`へその`reviewId`だけを渡してください。Serverが保存済みのproject、command、対象ファイル、Policy、runtime context、Safety Fingerprintを読み出して照合します。呼び出し側からfingerprintやcommandを指定して承認対象を変更することはできません。同じFingerprintの安全条件が維持されている場合だけ後続チェックで利用でき、変更があれば再評価されます。`deny`は常に優先され、Human Approvalで覆すことはできません。`jev_review_reject`でpending reviewを恒久的に拒否できます。

Human Reviewの期限は作成時から1時間で、承認操作によって延長されません。承認が必要な後続チェックでは、Jevを再評価してから承認の状態・期限・対象の完全一致を確認します。承認用fingerprintにはコード評価用fingerprint、command・対象ファイル・cwdのhash、安全Context、APIが返した実modelを含めます。これは`codeAssessment.fingerprint`と異なり、`jev_review_approve`が返す`fingerprint`は承認対象を示します。同じaliasでも実modelが変わり、引き続き承認が必要な判定なら新しいreviewが必要です。期限切れのpending／approved reviewは、新しいpending reviewへ置き換えます。API errorや後続の`deny`を過去の承認で迂回することはできません。

承認が必要なのに応答modelがversion付きの`jev-X.Y.Z`でない場合は、`JEV_MODEL_ID_UNVERIFIED`付きの`review`を返し、承認可能な`reviewId`は発行しません。provider／modelの応答を修正して再チェックし、このエラーを承認で通過させようとしないでください。

最小入力は次の形式です。

```json
{ "command": "npm test" }
```

必要に応じて`testCode`、`diff`、`cwd`、`environment`、`framework`、`context`、`isolation`、`runtime`を追加できます。generic policyは常に適用され、`framework`指定時だけframework-specific policyが追加適用されます。Laravel固有ルールは[`policies/tests/laravel.json`](policies/tests/laravel.json)にあります。

`testFiles`を指定した場合、ServerはPolicy、Cache、Human Review、Environment Approval、Jevによる審査より前に、指定された全ファイルを検証して読み込みます。`cwd`はMCP Serverのfilesystem上に存在し、各テストファイルはその内側にある通常ファイルかつ非symbolic linkでなければなりません。検証に失敗した場合、MCPの出力検証エラーではなく、`isError=true`、`ok=false`、`allowed=false`、`needsHumanReview=false`と構造化エラーを返します。不正な`cwd`は`TEST_CWD_NOT_FOUND`、`TEST_CWD_NOT_DIRECTORY`、`TEST_CWD_UNREADABLE`で識別できます。`TEST_FILE_VALIDATION_ERROR`では、`fileErrors`に`TEST_FILE_NOT_FOUND`、`TEST_FILE_OUTSIDE_CWD`、`TEST_FILE_SYMLINK`、`TEST_FILE_NOT_REGULAR`、`TEST_FILE_UNREADABLE`などのファイル別理由が入ります。パスまたはmountを修正して再試行してください。これらは入力エラーであり、Human Reviewは作成されず、承認で通過させることもできません。

### Safety Profile v3：テスト審査の一本化と継続的な実行承認

確認済みのローカルLaravel／Composer実行には、`jev_check_test`だけを使用します。同じテスト実行に`jev_check_command`を重ねません。テスト以外の操作には引き続き`jev_check_command`を使用します。

`.jev/test-safety.json`（または既存の`safetyProfilePath`）にProfile v3を定義します。既存のPHP安全runnerを使い、Execution Ticket、Ticket SDK、新しい隔離機構は要求しません。以下は設定例であり、本番用runnerの提供ではありません。実際のrunnerに合わせてパスとresource scopeを設定してください。

```json
{
  "version": 3,
  "name": "laravel-composer-test",
  "framework": "laravel",
  "environment": "testing",
  "entry": {
    "adapter": "composer-script",
    "script": "test"
  },
  "runner": {
    "file": "scripts/test-safe.php",
    "safetyFiles": [
      "tests/Support/DatabaseGuard.php"
    ],
    "testEntry": "vendor/bin/phpunit"
  },
  "selectors": {
    "filePatterns": [
      "tests/Unit/**",
      "tests/Feature/**"
    ],
    "allowFilter": true,
    "allowFullSuite": true
  },
  "environmentFiles": [
    "phpunit.xml",
    "config/database.php",
    "bootstrap/app.php"
  ],
  "codeReviewRoots": [
    "app",
    "tests/Support"
  ],
  "runtime": {
    "php": "/usr/bin/php",
    "composer": "/usr/local/bin/composer",
    "composerHome": "/home/developer/.config/composer",
    "configFiles": [
      "/etc/php.ini"
    ]
  },
  "resources": {
    "database": {
      "policy": "sqlite-memory",
      "rejectFallback": true,
      "rejectAdditionalConnections": true
    },
    "filesystem": {
      "writableRoots": [
        "storage/framework/testing",
        "bootstrap/cache"
      ]
    },
    "network": {
      "policy": "deny"
    },
    "credentials": {
      "policy": "deny"
    }
  }
}
```

例の各フィールドは、`runner.testEntry`（既定`vendor/bin/phpunit`）、`runtime.composerHome`（実際の`COMPOSER_HOME`またはComposerのXDG／従来home選択を使い、明示値はその位置と一致する必要があります）、`runtime.composer`（Composer adapterだけ必須）を除き必須です。初期v3対応はPOSIX上のローカル実行、`framework=laravel`、`environment=testing`、SQLite `:memory:`、network／credentialアクセス禁止に限定します。有効なPHP設定ファイルをすべて`runtime.configFiles`へ宣言してください。空配列は宣言対象がないことを人が確認したという意味で、ServerがPHPの無設定を検出したという意味ではありません。実行ファイルは空白を含まない単純なPOSIXパス文字による読み取り可能な絶対パス、runtime設定はsymlinkではない実ファイルを指定します。MCPと実行側でproject、実行ファイル、Composer home、runtime設定が一致する必要があります。独自homeを選ぶ場合は両processの`COMPOSER_HOME`を一致させてください。profileに別directoryを書くだけではComposerの参照先を変更できません。

`composer.json`が`"scripts": { "test": "@php scripts/test-safe.php" }`を定義している場合、次の入力で確認します。

```json
{
  "command": "composer test",
  "cwd": "/workspace/project",
  "framework": "laravel",
  "environment": "testing"
}
```

初回の有効なチェックは`executionReviewId`、`executionApproval.scope`、`execution-approval`理由を返します。正確なcommand、展開したscript chain、runner、guardファイル、runtime設定、resource scopeを人に提示してください。人はPHP runner全文、guardの読み込み経路、PHPUnit起動、引数転送を確認します。ソース内の参照だけではguardの強制やprocessの隔離は証明されません。明示的承認後だけ`jev_execution_approve({"approvalId":"exec_..."})`を呼び、再チェックします。`allowed=true`、`decision=allow`、`needsHumanReview=false`が揃った場合だけ実行できます。

承認後の定期失効はありません。pending reviewは1時間で期限切れになります。`jev_execution_reject`はpendingを拒否し、`jev_execution_revoke`はapprovedを取り消します。いずれも`approvalId`だけを受け取ります。reject／revoke／superseded済みIDは復活しません。`jev_check_test`の任意の`executionApprovalId`は、その有効な承認との完全一致を要求します。承認操作でも証拠を再読込するため、承認待ちの間に条件が変われば新しいreviewが必要です。承認状態の変更はコードcacheの判定と別に記録します。

Serverはprofileの元バイト列、project root、入口形式・固定引数、全script chain、runner／guard／環境ファイル、コマンド用とテスト用の適用Policy、PHP／Composer実行ファイル・runtime設定、安全性に関係するprocess環境のdigest、Composer依存／global metadata、インストール済み`vendor`の元バイト列を照合します。存在する`.env`、`.env.testing`、`bootstrap/cache/config.php`、`tests/TestCase.php`、Composer lock／installed／autoload metadata、XML bootstrapは自動追跡し、不在からの追加も検出します。テスト本文、現在のテスト一覧、許可済みfilterは実行承認の同一性へ含めません。通常の`codeReviewRoots`変更はコード再審査、環境／guard入力にも分類されたファイルの変更は実行再承認です。依存再インストールやautoload更新でも再承認が必要になる場合があります。provider／model変更はコード再審査だけを要求し、実行承認を失効させません。Jev接続用keyは引き続き対象外です。

全対象テストを承認／cache／APIより前に読み、Policy、fingerprint、コード評価に同じ元バイト列snapshotを使います。関連コードと実行ソースの合計は64ファイル、1ファイル32 KiB、合計64 KiB、探索4096entryです。v3の各テストファイルにも32 KiBの読込上限があります。全suiteは最大128テストファイル、探索4096entryです。インストール済み依存manifestは20000ファイル、40000entry、1ファイル8 MiBまでです。完成したテスト用API JSONは従来どおり256 KiBまでで、証拠を無断で切り詰めたり除外したりしません。

Composer adapterは`composer test`／`composer run-script test`、commandの前の任意の`--no-plugins`、`--`以降のselector引数に対応します。単純な`@script`参照を展開し（最大深さ16・64handler）、PHP安全runnerのleafを1つだけ要求します。配列の全要素を解決します。leafは`@php`、`php`、設定したPHPパスに対応します。ComposerのPHP shebangと`php` leafは設定したPHPへ解決される必要があります。独自vendor／bin directory、PHP callback／Command handler、event handler、script参照の引数、`@putenv`、`@composer`、追加引数位置指定、shell複合式・展開・wrapperは未対応です。インストール済み／global pluginがある場合は明示的な`--no-plugins`が必要で、それ以外は読み取ったmetadataから不在を確認します。直接実行は`"entry":{"adapter":"php-runner"}`と`php scripts/test-safe.php`です。名前指定の実行ファイルは設定した実体へ解決される必要があり、PATHが異なる場合は絶対パスを使います。PHP runnerは人が全文確認する明示的な境界で、importや動的processの自動解決ではありません。明白なshell／eval呼び出しは停止します。

変更できる引数は`filePatterns`内の相対PHPファイルと、許可された1つの`--filter VALUE`だけです。configuration／bootstrap／PHP optionや任意の引数は禁止します。全suiteは実際のXML `testsuites`のfile／directoryを列挙し、指定する`testFiles`は対象集合と完全一致させます。一部だけの指定では許可しません。filterだけでも対象ファイル全体を審査します。XML DTD、exclude、extension、独自loaderは未対応です。インライン`testCode`やv2の`execution`／`environmentApprovalId`はv3へ混在できません。コンテナ／remote／wrapperは停止するので、MCPと確認対象の直接実行を同じnamespaceで行い、内側のcommandだけを抜き出して許可しないでください。

単一の入口でコマンド用・テスト用のBuilt-in／User／Projectルールを適用します。実行承認は自身の実行条件reviewだけを解消します。承認済みチェックではコードcache HIT時もコマンドを毎回Jevへ評価させ、コマンドallow cacheは読み書きしません。コードは既存条件を満たす自動allow cacheだけを再利用できます。別のcommand／codeリスクは実modelに紐付いた`reviewId`／`reviewIds`と`reviewReasons`で区別し、既存Human Review操作後に再チェックします。承認由来allowは自動cacheへ保存しません。後続deny、必要なAPI評価の失敗、証拠不足、未対応形式、対象不一致、承認storeの障害は、実行承認や旧cacheで迂回できません。

`reviewReasons`は`execution-approval`、`command-risk`、`code-risk`、`evidence-incomplete`、`evaluation-error`を区別します。`approvable=true`でServer発行IDがある理由だけを承認できます。`INVALID_EXECUTION_PROFILE`、`EXECUTION_CHAIN_UNRESOLVED`、`UNSUPPORTED_EXECUTION_FORM`、`EXECUTION_TARGET_MISMATCH`、`EXECUTION_SELECTOR_OUTSIDE_SCOPE`、`EXECUTION_DEPENDENCY_INCOMPLETE`、`EXECUTION_APPROVAL_MISMATCH`などは修正して再チェックし、人の承認だけで通しません。v3承認履歴のあるprojectでは、profile削除・downgradeで旧来の申告ベース承認へ戻れません。Composerテスト実行は履歴がなくてもv3を要求します。

確認したものと同じcommandを既存runnerで実行します。runnerは毎回SQLite memoryの強制、実接続の確認、永続／fallback／追加接続の拒否、設定cacheの処理を行う必要があります。コード、対象、command、安全条件が変われば再チェックします。ゲートはOS sandbox、filesystem lock、チェックと実行の間の変更防止を自動提供しません。

移行：旧processを停止し、SQLite／WALの整合したバックアップ後に更新してください。起動時にtransaction内でschema 6から7へ実行承認storeを追加します。30日期限のEnvironment Approvalを無期限承認へ変換せず、履歴／cacheを削除しません。v1／v2の証拠評価と任意のv2 Ticketは残ります。Composerテスト実行はv3へ移行し、初回の実行承認を取得してください。v3コードの同一性はlegacy profileと分離します。旧Serverはschema 7を開けず、downgradeには更新前backupが必要です。利用先に配布済みの`JEV_POLICY.md`もServerと同時に更新してください。

### 従来のSafety Profileとコード評価の同一性

プロジェクトは`.jev/test-safety.json`で、再利用するテスト安全条件を定義できます。ProfileはLaravel専用ではなく、安全関連ファイル、test runner、DB、隔離、runtime条件を宣言します。Profileは許可証や安全保証ではなく、Built-in／User／Project PolicyやJevの`deny`を上書きしません。

Profileに記載したファイルはSHA-256でfingerprint化します。verified stateはリポジトリ外のユーザー設定ディレクトリ（または`JEV_TEST_SAFETY_STATE_PATH`）へ保存し、Gitへコミットしません。`jev_check_test`は読み取り専用のまま、明示的なverificationでstateを作成します。

Jev providerと要求modelは、コード評価用Safety Fingerprintの一部です。どちらかを変更すると、以前のJev allow cache、Human Reviewの一致、コードに紐付くExecution Ticketは再利用されず、コードが再評価されます。Environment Approvalはコード評価と分離されているため、provider/model変更だけでは、一致するEnvironment Approvalを失効させません。provider情報を持たない旧cacheも再利用しません。Jev接続用のAPI keyはfingerprintやcache keyへ含めないため、provider/modelを変えずに接続用keyだけをローテーションしても、それだけでは安全判定を失効させません。

テスト入力の同一性判定とAPI送信用のマスクは分離しています。`testFiles`では、評価に使う同じ読み込み結果から計算した元バイト列のSHA-256 digestをコードfingerprintへ含めます。インラインの`testCode`、`diff`、`context`は、マスク・改行変換・Unicode正規化より前にハッシュ化し、未指定と空文字列も区別します。テストcommandもマスク前にハッシュ化し、Human Approvalの照合と、Safety Profile v2／v3以外のコード評価に使用します。マスク対象の値だけの変更でも再評価し、必要なら新しいHuman Reviewを要求します。変更のない再利用条件を満たす入力では、自動判定のallow cacheを引き続き利用できます。複数ファイルでは、共通の安全Contextも変化しない限り変更の影響を受けたファイルだけを再評価します。Profile v2はコードの同一性と環境・実行指定を分離するため、コードだけの変更では一致するEnvironment Approvalを維持し、許可されたfilterだけの変更ではコード評価を再利用できます。

元の入力は変更検出のためメモリ内で扱い、この同一性判定によってfingerprintへ追加するのはdigestだけで、平文は追加しません。APIへは引き続きマスク済みの入力を送り、個別フィールドのdigestをAPI payloadやMCP応答へ追加しません。ハッシュ化は暗号化ではなく、推測しやすい内容の特定を防ぐ保証でもありません。評価対象のコードやテスト引数に含まれる認証情報は、ServerのJev接続用認証情報とは異なり、digestへ影響します。

以前の`raw-test-input-v1`へのevaluator更新自体はDB移行なしで入力の同一性を変更しました。現行リリースはschema 7を使用します。旧Serverのプロセスを停止し、更新したbuildで再起動してください。以前のcacheとHuman Reviewは履歴として残りますが、新しいevaluator／入力の同一性には一致しません。再チェックし、必要に応じて新しいHuman Reviewを受けてください。監査履歴と、一致するEnvironment Approvalは保持します。以前のExecution Ticketは新しく計算したコードfingerprintに一致しないため、更新したrunnerの現在のfingerprint検証に使う前に`jev_check_test`で新しいTicketを取得してください。古いevaluatorは旧レコードに一致し得るため、同じcacheを古いevaluatorで使用しないでください。

SQLite schema 5以前から更新する場合は、旧Serverのプロセスを停止し、cache DB（`cache/jev.sqlite`、または`JEV_CACHE_DB_PATH`）をバックアップしてから更新後のServerを起動してください。未反映のWALデータも含め、SQLiteとして整合性のあるバックアップを取得してください。起動時にトランザクション内でschema 6を経てschema 7へ自動移行します。既存allow cacheは承認由来かどうかを確実に区別できないため、履歴を保持したまますべて再利用不可にします。旧Human Reviewも履歴として残りますが、実modelを含む新しい承認用fingerprintとは一致せず、承認が必要なチェックでは新しいreviewが必要です。監査履歴と、一致するEnvironment Approvalは保持します。コード評価には新しいevaluator versionを使用します。更新後は一度再評価され、必要に応じて新しいHuman Reviewが発生します。移行失敗時は変更をロールバックし、DBを自動削除しません。旧Serverはschema 7を開けないため、ダウングレードには更新前のバックアップを復元する必要があります。

```sh
npm run verify-test-safety -- --cwd /path/to/project --input /path/to/jev-verification-input.json
```

人間による初回確認後、Profile、対象ファイル、runtime条件が同じで、Jevも低リスクなら、同じ確認を毎回要求せず`allow`にできます。Profile変更、対象ファイル欠落、runner/framework変更、隔離条件変更、無効なProfile、Policy違反、新しいリスクがあれば`review`または`deny`に戻ります。Profileやverified stateへcredentialや`.env`の実値を保存しないでください。

本サーバーは入力されたevidenceを評価するだけで、実行中プロセスやDBへ接続したり、runtimeの申告が正しいことを証明したりはしません。

#### 任意の従来方式：Safety Profile v2とEnvironment Approval

Profile v2では、人が初回確認する実行環境と、変更ごとに自動審査するテストコードを分離します。`environmentFiles`またはrunner本体が変わると環境再承認が必要ですが、テスト、assertion、許可された対象ファイル、filterの変更では環境承認を失効させません。`codeReviewRoots`配下のファイル追加・削除・元バイト列の変更は、対応するコード審査キャッシュとHuman Approvalを失効させますが、それ以外が一致するEnvironment Approvalは維持します。

```json
{
  "version": 2,
  "name": "laravel-safe-runner",
  "framework": "laravel",
  "environment": "testing",
  "runner": {
    "id": "laravel-safe-v1",
    "executable": "bin/safe-test-runner",
    "files": ["bin/safe-test-runner"],
    "fixedArgs": [],
    "shell": false,
    "selectors": { "filePatterns": ["tests/**"], "allowFilter": true }
  },
  "environmentFiles": ["phpunit.xml", "bootstrap/app.php", "config/database.php"],
  "codeReviewRoots": ["app", "tests/Support", "composer.json", "composer.lock"],
  "resources": {
    "database": { "policy": "sqlite-memory", "rejectFallback": true, "rejectAdditionalConnections": true },
    "filesystem": { "writableRoots": ["storage/framework/testing"] },
    "network": { "policy": "deny" },
    "credentials": { "policy": "deny" }
  }
}
```

Profile v2では`testFiles`と同じファイルを示す構造化`execution`を`jev_check_test`へ渡します。`command`にはrunnerの相対パスだけを指定し、対象やfilterをshell文字列へ連結しません。

各チェックで、Serverは`codeReviewRoots`配下の全ファイルの現在のUTF-8本文を読み、重複するrootを重複排除します。同一のメモリ上のスナップショットから元バイト列のdigestを作り、Built-in／User／Project Policy・frameworkの静的検査を行い、マスクした`relatedCode`（`file`、`content`）をJevへ送ります。1リクエスト内の複数`testFiles`はこのスナップショットを共有します。関連コードのfindingにはproject相対パスの`file`が付く場合があります。平文の本文はSQLite・ログ・MCP結果へ保存せず、Server外へ送る本文はマスク済みのみです。マスクはbest effortなので、利用前に設定範囲の機密情報を確認してください。

審査上限は関連ファイル64件、1ファイル32 KiB、元バイト列の合計64 KiB、ディレクトリを含む探索entry 4096件、完成したJevリクエストのJSON全体256 KiBです。存在しない／読めないパス、親要素を含むsymlink、通常ファイル以外、binary／非UTF-8、上限超過では`RELATED_CODE_REVIEW_INCOMPLETE`、`decision=review`、`allowed=false`で停止します。無断の切り詰めや拡張子による除外はしません。承認可能な`reviewId`、cache／Human Approvalによる迂回、Execution Ticketはなく、範囲・読み取り可否・リクエスト容量を修正して再チェックしてください。検出済みの静的`deny`は維持します。関連コードの審査失敗だけでは一致するEnvironment Approvalを失効させません。

審査範囲は指定テストと明示した`codeReviewRoots`のみで、import・package・動的依存を自動展開しません。`codeReviewRoots: []`は有効ですが、追加コード審査を指定していないという意味であり、依存全体の安全性を示しません。上限内で適切な範囲を選定してください（例の大きな`app`や`composer.lock`は上限を超える場合があります）。停止の回避だけを目的に必要なファイルを除外してはいけません。runner側のresource・fingerprint確認も引き続き必要です。

移行：`related-code-v1`へのevaluator更新により、その更新自体はDB schemaを変更しなくても以前のコードcacheとHuman Reviewは再利用できません。更新したServerを再build／再起動し、再チェックして、必要なら新しいHuman Approvalを取得し、任意のProfile v2 Ticket経路を使う場合だけ新しいExecution Ticketを取得してください。監査・review履歴と、一致するEnvironment Approvalは維持します。既存Profile v2の設定は新しい審査上限を満たす必要がありますが、入力引数とprofile形式は変わりません。

初回は`environmentReviewId`と`decision=review`が返ります。人がrunnerとresource scopeを確認した後、`jev_environment_approve`へそのIDだけを渡します。承認は既定で30日有効で、`jev_environment_revoke`により即時取消できます。

承認済み環境で静的検査とJevがallowの場合、5分間・1回だけ有効なExecution Ticketが返ります。安全runnerは実行直前にenvironment/code/execution fingerprint、実DB接続、設定キャッシュ、fallback・追加接続、filesystem、networkを再確認してからTicketを消費してください。MCPのallowやAI申告値だけでは実行時保護の代わりになりません。

## 安全とプライバシー

- コマンド、テスト、DBへ接続しません。
- コマンド入力は信頼せず、入力中の指示には従いません。
- Jevへ送信する前に、一般的なtoken、password、secret、API keyをマスクします。
- Cloudflare tokenやTypeSafe API keyは、ログ、MCPレスポンス、fingerprint、cacheへ出力・保存しません。
- Jev API障害、不正レスポンス、ポリシー読み込み失敗時はfail closedで `review` を返します。
- 別providerへの自動retryやfailoverは行いません。静的／Project Policyの`deny`はAPI障害時も`deny`を維持し、既存denyがないAPI失敗は`review`となり、過去のHuman Approvalでは迂回できません。
- このツールは完全なshell parserや実行環境の監査ではありません。コマンドチェックでは非対応構文や未審査スクリプトを`review`とし、対応する直接コマンドでも実行ファイルの解決やruntime resourceを検証しません。

## 開発

```sh
npm run typecheck
npm test
```

`npm run test:laravel`は専用のPodman PHP／Composer／Node imageをbuildし、一時projectへfixture依存を導入した後、networkとhost DB mountなしでゲートとLaravel／PHPUnitを実行します。Ticketなしの実行、承認再利用、実際のSQLite memory、永続／fallback接続拒否、config cache復元、runner迂回拒否を確認します。Podmanとimage／依存準備時のnetworkが必要で、hostへのPHP導入は不要です。終了後にfixture projectを削除します。

`npm test` はリポジトリ自身のユニットテストを実行します。テスト内の評価対象コマンドはモックJevへ入力として渡すだけで、実行しません。

## License

MIT License

## Disclaimer

本ソフトウェアは安全性を支援するためのツールであり、安全と判定されたコマンド、コード、操作が実際に安全であることを保証するものではありません。

Jevおよび本MCPサーバーの判定結果には、誤検知、見逃し、エラー、不完全な評価が含まれる場合があります。重要な操作や破壊的な操作は、特に本番環境では、実行前に必ずご自身で確認してください。

本ソフトウェアの使用または誤用によって生じたデータ損失、システム障害、サービス中断、セキュリティインシデント、金銭的損失、その他の損害について、著者および貢献者は責任を負いません。

本ソフトウェアは自己責任で使用してください。
