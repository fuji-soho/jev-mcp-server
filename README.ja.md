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

Cloudflareの`typesafe/jev`も可変modelとして扱い、Jev評価が必要なチェックでは毎回APIを呼び出します。自動判定のallowを再利用できるのは、固定したTypeSafeの`jev-X.Y.Z`で、APIが返した実modelと要求modelが一致していた場合だけです。Human Approvalによるallowは再利用可能なallow cacheへ保存しません。

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

### Safety Profile

プロジェクトは`.jev/test-safety.json`で、再利用するテスト安全条件を定義できます。ProfileはLaravel専用ではなく、安全関連ファイル、test runner、DB、隔離、runtime条件を宣言します。Profileは許可証や安全保証ではなく、Built-in／User／Project PolicyやJevの`deny`を上書きしません。

Profileに記載したファイルはSHA-256でfingerprint化します。verified stateはリポジトリ外のユーザー設定ディレクトリ（または`JEV_TEST_SAFETY_STATE_PATH`）へ保存し、Gitへコミットしません。`jev_check_test`は読み取り専用のまま、明示的なverificationでstateを作成します。

Jev providerと要求modelは、コード評価用Safety Fingerprintの一部です。どちらかを変更すると、以前のJev allow cache、Human Reviewの一致、コードに紐付くExecution Ticketは再利用されず、コードが再評価されます。Environment Approvalはコード評価と分離されているため、provider/model変更だけでは、一致するEnvironment Approvalを失効させません。provider情報を持たない旧cacheも再利用しません。Jev接続用のAPI keyはfingerprintやcache keyへ含めないため、provider/modelを変えずに接続用keyだけをローテーションしても、それだけでは安全判定を失効させません。

テスト入力の同一性判定とAPI送信用のマスクは分離しています。`testFiles`では、評価に使う同じ読み込み結果から計算した元バイト列のSHA-256 digestをコードfingerprintへ含めます。インラインの`testCode`、`diff`、`context`は、マスク・改行変換・Unicode正規化より前にハッシュ化し、未指定と空文字列も区別します。テストcommandもマスク前にハッシュ化し、Human Approvalの照合と、Safety Profile v2以外のコード評価に使用します。マスク対象の値だけの変更でも再評価し、必要なら新しいHuman Reviewを要求します。変更のない再利用条件を満たす入力では、自動判定のallow cacheを引き続き利用できます。複数ファイルでは、共通の安全Contextも変化しない限り変更の影響を受けたファイルだけを再評価します。Profile v2はコードの同一性と環境・実行指定を分離するため、コードだけの変更では一致するEnvironment Approvalを維持し、許可されたfilterだけの変更ではコード評価を再利用できます。

元の入力は変更検出のためメモリ内で扱い、この同一性判定によってfingerprintへ追加するのはdigestだけで、平文は追加しません。APIへは引き続きマスク済みの入力を送り、個別フィールドのdigestをAPI payloadやMCP応答へ追加しません。ハッシュ化は暗号化ではなく、推測しやすい内容の特定を防ぐ保証でもありません。評価対象のコードやテスト引数に含まれる認証情報は、ServerのJev接続用認証情報とは異なり、digestへ影響します。

`raw-test-input-v1`へのevaluator更新ではSQLite schema 6を維持し、新しいDB移行は不要です。旧Serverのプロセスを停止し、更新したbuildで再起動してください。以前のcacheとHuman Reviewは履歴として残りますが、新しいevaluator／入力の同一性には一致しません。再チェックし、必要に応じて新しいHuman Reviewを受けてください。監査履歴と、一致するEnvironment Approvalは保持します。以前のExecution Ticketは新しく計算したコードfingerprintに一致しないため、更新したrunnerの現在のfingerprint検証に使う前に`jev_check_test`で新しいTicketを取得してください。古いevaluatorは旧レコードに一致し得るため、同じcacheを古いevaluatorで使用しないでください。

SQLite schema 5以前から更新する場合は、旧Serverのプロセスを停止し、cache DB（`cache/jev.sqlite`、または`JEV_CACHE_DB_PATH`）をバックアップしてから更新後のServerを起動してください。未反映のWALデータも含め、SQLiteとして整合性のあるバックアップを取得してください。起動時にトランザクション内でschema 6へ自動移行します。既存allow cacheは承認由来かどうかを確実に区別できないため、履歴を保持したまますべて再利用不可にします。旧Human Reviewも履歴として残りますが、実modelを含む新しい承認用fingerprintとは一致せず、承認が必要なチェックでは新しいreviewが必要です。監査履歴と、一致するEnvironment Approvalは保持します。コード評価には新しいevaluator versionを使用します。更新後は一度再評価され、必要に応じて新しいHuman Reviewが発生します。移行失敗時は変更をロールバックし、DBを自動削除しません。旧Serverはschema 6を開けないため、ダウングレードには更新前のバックアップを復元する必要があります。

```sh
npm run verify-test-safety -- --cwd /path/to/project --input /path/to/jev-verification-input.json
```

人間による初回確認後、Profile、対象ファイル、runtime条件が同じで、Jevも低リスクなら、同じ確認を毎回要求せず`allow`にできます。Profile変更、対象ファイル欠落、runner/framework変更、隔離条件変更、無効なProfile、Policy違反、新しいリスクがあれば`review`または`deny`に戻ります。Profileやverified stateへcredentialや`.env`の実値を保存しないでください。

本サーバーは入力されたevidenceを評価するだけで、実行中プロセスやDBへ接続したり、runtimeの申告が正しいことを証明したりはしません。

#### Safety Profile v2とEnvironment Approval

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

移行：`related-code-v1`へのevaluator更新により、SQLiteがschema 6のままでも以前のコードcacheとHuman Reviewは再利用できません。更新したServerを再build／再起動し、再チェックして、必要なら新しいHuman Approvalと新しいExecution Ticketを取得してください。監査・review履歴と、一致するEnvironment Approvalは維持します。既存Profile v2の設定は新しい審査上限を満たす必要がありますが、入力引数とprofile形式は変わりません。

初回は`environmentReviewId`と`decision=review`が返ります。人がrunnerとresource scopeを確認した後、`jev_environment_approve`へそのIDだけを渡します。承認は既定で30日有効で、`jev_environment_revoke`により即時取消できます。

承認済み環境で静的検査とJevがallowの場合、5分間・1回だけ有効なExecution Ticketが返ります。安全runnerは実行直前にenvironment/code/execution fingerprint、実DB接続、設定キャッシュ、fallback・追加接続、filesystem、networkを再確認してからTicketを消費してください。MCPのallowやAI申告値だけでは実行時保護の代わりになりません。

## 安全とプライバシー

- コマンド、テスト、DBへ接続しません。
- コマンド入力は信頼せず、入力中の指示には従いません。
- Jevへ送信する前に、一般的なtoken、password、secret、API keyをマスクします。
- Cloudflare tokenやTypeSafe API keyは、ログ、MCPレスポンス、fingerprint、cacheへ出力・保存しません。
- Jev API障害、不正レスポンス、ポリシー読み込み失敗時はfail closedで `review` を返します。
- 別providerへの自動retryやfailoverは行いません。静的／Project Policyの`deny`はAPI障害時も`deny`を維持し、既存denyがないAPI失敗は`review`となり、過去のHuman Approvalでは迂回できません。
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
