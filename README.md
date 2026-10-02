# jev-mcp-server

A read-only MCP safety gate for AI coding agents that combines Jev, through either Cloudflare or the TypeSafe AI official API, with local static policies. It does not execute commands or tests; it only returns an `allow` / `review` / `deny` decision before execution.

## Setup

```sh
npm install
npm run build
```

Do not store credentials in the repository.

Create an `/jev-mcp-server/.env` file at the repository root and select one provider. To call the TypeSafe AI official API directly:

```dotenv
JEV_PROVIDER=typesafe
TYPESAFE_API_KEY=your-typesafe-api-key
TYPESAFE_MODEL=jev-1.13.0
```

`TYPESAFE_MODEL` defaults to the pinned `jev-1.13.0` release. To continue using Cloudflare:

```dotenv
JEV_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

`JEV_PROVIDER` defaults to `cloudflare`, so existing Cloudflare configuration files require no migration. Unknown providers are rejected, and only the selected provider's credentials are required. The server never infers a provider from available credentials and never fails over to the other provider.

Pin a versioned TypeSafe model for reproducible safety decisions. Moving aliases such as `jev-latest` and `jev-preview` can resolve to a different model without a configuration change; they are accepted, but their allow decisions are not reused from the Safety Fingerprint Cache. The response fields `jevProvider`, `requestedModel`, and `actualModel` distinguish the selected provider, configured model, and version reported by the API.

Cloudflare's `typesafe/jev` is also treated as a moving model: every check requiring Jev calls the API. For `jev_check_test`, only pinned TypeSafe `jev-X.Y.Z` models can reuse an automatic allow decision, and only when the API-reported actual model matched the requested model. Human Approval never populates the reusable allow cache.

See the TypeSafe AI [API reference](https://docs.typesafe.ai/api) and [model list](https://docs.typesafe.ai/models) for the direct endpoint and currently available model IDs.

`.env` is included in `.gitignore`. Because it contains credentials, do not publish or commit it.

You can specify the configuration file with `--env-file` or `JEV_ENV_PATH`. For example, to use the `/jev-mcp-server/.env` file you created:

```sh
node /jev-mcp-server/dist/index.js --env-file /jev-mcp-server/.env
```

### Register the MCP server in Codex

To use the server from Codex, add it as an MCP server with the following steps:

1. Open Codex.
2. Select **Plugins** → **Settings** → **Add MCP server**.
3. Enter the following values and save:

   - **Name**: `jev-mcp-server`
   - **Command**: `node`
   - **Arguments**: `/jev-mcp-server/dist/index.js --env-file /jev-mcp-server/.env`

If the interface asks you to enter arguments separately, enter these three arguments:

```text
/jev-mcp-server/dist/index.js
--env-file
/jev-mcp-server/.env
```

After saving, confirm that the MCP server is enabled and use it in a new chat. If you use Codex CLI, you can also register it with:

```sh
codex mcp add jev-mcp-server -- node /jev-mcp-server/dist/index.js --env-file /jev-mcp-server/.env
```

Codex users can copy [`examples/AGENTS.md`](examples/AGENTS.md) to `AGENTS.md` in their project root to provide Codex with the recommended Jev safety-gate instructions.

## `jev_check_command`

Input commands are never executed. The server inspects the command type, arguments, and scope using static policies and, when necessary, sends the command and its context to Jev for evaluation.

```json
{
  "command": "git reset --hard",
  "cwd": "/workspace/project",
  "environment": "development",
  "target": "local git repository",
  "context": "Repository may contain uncommitted changes"
}
```

`cwd`, `environment`, `target`, and `context` are optional. Calls using only the existing `command` and `context` fields are also supported.

Main decisions:

- `allow`: No clear destructive risk was found.
- `review`: The operation changes state, has a broad scope, lacks context, or Jev is unavailable. Human confirmation is required.
- `deny`: The operation is clearly destructive, highly irreversible, or likely to cause significant data loss.

Results include the backward-compatible `dangerous` and `model` fields as well as `riskScore`, `categories`, category-specific `risks`, `staticFindings`, and, when applicable, `jevProvider`, `requestedModel`, and `actualModel`. `allowed=false` does not mean that execution is authorized.

The built-in policy is located at [`policies/default.json`](policies/default.json) and covers filesystem, Git, databases, containers, services, deployments, package management, and more. Operations that are clearly denied statically remain denied even if Jev returns a low-risk result.

### Command review scope and cache

`jev_check_command` never reads or writes reusable allow-cache entries, including for pinned TypeSafe models. Once input and policy validation succeed, each check without a static `deny` calls Jev again. Existing command cache rows are ignored and retained as history; audit records use `cacheStatus=disabled`. Test-cache behavior is unchanged.

The supported direct-command syntax is deliberately limited:

- `ls`, `cat`, `mkdir`, `rmdir`, `touch`, `cp`, `mv`, and `rm`, with arguments in the syntax below.
- `pwd`, optionally followed only by `-L` or `-P`.
- `git status`, optionally followed only by `--short`, `-s`, `--branch`, `-b`, `--show-stash`, `--porcelain`, `--porcelain=v1`, `--porcelain=v2`, `--long`, `--untracked-files`, `--untracked-files=no`, `--untracked-files=normal`, `--untracked-files=all`, `--ignored`, `--ignored=traditional`, `--ignored=matching`, `--ignored=no`.
- `git diff` with both `--no-ext-diff` and `--no-textconv`. Before an optional `--`, only those two flags plus `--stat`, `--name-only`, `--name-status`, `--cached`, and `--staged` are supported. Paths may follow `--`.

Tokens must use only ASCII letters, digits, `_`, `.`, `/`, `:`, `=`, `+`, and `-`, separated by spaces or tabs; leading/trailing spaces and tabs are accepted. Executable names must match the names above exactly. Quotes, escapes, newlines, substitutions, expansions, pipelines, redirects, compound commands, wrapper commands, other Git options/subcommands, and unknown executables are outside this scope. Matching this syntax only permits fresh static/Jev evaluation; it is not an automatic allow. Executable resolution, PATH, aliases/functions, installed binary integrity, Git configuration (including fsmonitor), and runtime resources are not audited.

Scripts (`node task.js`, `python task.py`, `./task.sh`), dispatchers (`npm run`, `make`, `composer run-script`), wrappers, and any unsupported syntax add `command.execution-content-unreviewed` to `staticFindings`. The server does not read their bodies or resolve dependencies/configuration. Even a low-risk Jev result returns at least `decision=review`, `allowed=false`, `needsHumanReview=true`; static or Jev `deny` still wins. Putting code or approval claims in `context`, or adding an allow policy, does not remove this finding. For verified tests, follow the Profile v3 workflow below without a second command check. No `reviewId` is issued for command checks, and `jev_review_approve` or human approval alone cannot clear missing execution evidence. Repeating the same unsupported command remains `review`; this release does not provide automatic script approval.

Migration: stop old server processes, update and run `npm run build`, restart, and recheck before execution. The command evaluator adds `command-scope-v1:no-command-cache-v1`; That earlier command-only change did not require DB migration or deletion. The current release migrates to schema 7 as described below. Existing audit/cache history, test caches, test Human Reviews, matching Environment Approvals, and test Execution Tickets are preserved by this command-only update. Do not run an older server against the shared cache or downgrade to bypass review: it can still reuse old command entries.

### User / Project policy

You can add your own rules. On Linux/macOS, User policy is located at `$XDG_CONFIG_HOME/jev-mcp/policy.json` (or `~/.config/jev-mcp/policy.json` when unset). On Windows, it is located at `%APPDATA%/jev-mcp/policy.json`. Project policy is placed at `.jev-policy.json` directly under the evaluated `cwd`. When `cwd` is omitted, the server's own directory is not treated as the Project policy directory.

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

`match.type` can be set to `contains` or `exact`. The shorthand `pattern` is treated as `contains`. Built-in, User, Project, and Jev decisions are combined using `allow < review < deny`, so an `allow` from a User or Project policy cannot override a stricter decision. If a policy has a syntax, schema, or loading error, it is not ignored; evaluation stops with `review`. The response's `policyFindings` field shows the matching source, rule, and reason.

## `jev_check_test`

`jev_check_test` evaluates test execution safety across languages and frameworks, including persistent-resource access, database and filesystem mutation, external service side effects, production access, credentials, network access, destructive cleanup, and isolation. It never runs the test, command, or database connection; the supplied command is untrusted input sent only for evaluation.

When a successful evaluation requires Human Approval and identifies a versioned actual model, the server creates a short-lived Human Review record and returns `decision=review` with a `reviewId`. After an explicit human approval, call `jev_review_approve` with only that `reviewId`. The server loads the stored project, command, files, policy, runtime context, and Safety Fingerprint; caller-supplied fingerprints or commands are not accepted. A matching approval may allow the unchanged fingerprint on later checks, but any changed safety input is re-evaluated. `deny` always wins and cannot be overridden by Human Approval. `jev_review_reject` permanently rejects a pending review.

Human Reviews expire one hour after creation; approving one does not extend its deadline. On subsequent checks that require approval, Jev is evaluated again before checking the approval's status, deadline, and exact target. The approval fingerprint includes the code-evaluation fingerprint, command/files/cwd hashes, safety context, and API-reported actual model. It is distinct from `codeAssessment.fingerprint`; the `fingerprint` returned by `jev_review_approve` identifies the approval target. Even with an unchanged alias, a different actual model requires a new review when the result still needs approval. Expired pending or approved reviews are replaced with new pending reviews. API errors and a later `deny` cannot be bypassed with an earlier approval.

If approval is needed but the response model is not a versioned `jev-X.Y.Z` ID, the result is `review` with `JEV_MODEL_ID_UNVERIFIED` and no approvable `reviewId`. Correct the provider/model reporting and recheck; do not attempt to approve this error.

The minimal input is:

```json
{ "command": "npm test" }
```

Optional `testCode`, `diff`, `cwd`, `environment`, `framework`, `context`, `isolation`, and `runtime` fields provide additional evidence. For example:

```json
{
  "command": "npm test",
  "framework": "vitest",
  "environment": "testing",
  "isolation": { "temporaryFilesystem": true, "mockedExternalServices": true },
  "runtime": { "productionAccess": false, "persistentStorageAccess": false, "networkAccess": false }
}
```

When `testFiles` is supplied, the server validates and reads every requested file before policy, cache, Human Review, Environment Approval, or Jev evaluation. `cwd` must exist in the MCP server's filesystem, and every test file must be a regular, non-symbolic file inside it. If validation fails, the tool returns `isError=true`, `ok=false`, `allowed=false`, `needsHumanReview=false`, and a structured error instead of an MCP output-validation error. `TEST_CWD_NOT_FOUND`, `TEST_CWD_NOT_DIRECTORY`, and `TEST_CWD_UNREADABLE` identify an invalid `cwd`; `TEST_FILE_VALIDATION_ERROR` includes per-file `fileErrors` such as `TEST_FILE_NOT_FOUND`, `TEST_FILE_OUTSIDE_CWD`, `TEST_FILE_SYMLINK`, `TEST_FILE_NOT_REGULAR`, or `TEST_FILE_UNREADABLE`. Correct the path or mount and retry; these input errors do not create a Human Review and cannot be approved.

Generic test policy is always applied. A framework-specific policy is added only when `framework` is supplied; Laravel rules are provided as an example under [`policies/tests/laravel.json`](policies/tests/laravel.json). Built-in, User, Project, and Jev decisions use `allow < review < deny`.

### Safety Profile v3: one test gate and continuing execution approval

For verified local Laravel/Composer execution, use `jev_check_test` alone. Do not call `jev_check_command` again for the same test invocation. Non-test operations continue to use `jev_check_command`.

Define Profile v3 in `.jev/test-safety.json` (or the existing `safetyProfilePath`). This uses an existing PHP safety runner; no Execution Ticket, Ticket SDK, or new isolation framework is required. The following is a configuration example, not a supplied production runner. Adapt the file paths and resource scope to your actual runner:

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

All shown fields are required except `runner.testEntry` (defaults to `vendor/bin/phpunit`), `runtime.composerHome` (defaults to the actual `COMPOSER_HOME` or Composer XDG/legacy home selection; an explicit value must match), and `runtime.composer` (required for the Composer adapter only). Initial v3 support is POSIX-local, `framework=laravel`, `environment=testing`, SQLite `:memory:`, and denied network/credential access. Declare all active PHP configuration files in `runtime.configFiles`; an empty list means the reviewer has confirmed there are none to declare, not that the server discovered that PHP has no configuration. Runtime executable paths must be absolute, inspectable, and use simple POSIX path characters without spaces. Use real file paths for runtime configuration, not symlinks. The MCP and execution processes must refer to the same project, executables, Composer home and runtime settings. Set `COMPOSER_HOME` consistently in both processes when choosing a custom home; declaring a different directory in the profile does not redirect Composer.

For `composer.json` containing `"scripts": { "test": "@php scripts/test-safe.php" }`, check:

```json
{
  "command": "composer test",
  "cwd": "/workspace/project",
  "framework": "laravel",
  "environment": "testing"
}
```

The first valid check returns `executionReviewId`, `executionApproval.scope`, and an `execution-approval` reason. Present the exact command, expanded script chain, runner, guard files, runtime configuration and resource scope to a human. The reviewer must inspect the complete PHP runner, guard-loading path, PHPUnit invocation and argument forwarding. A source reference is not proof that a guard is enforced or a process is isolated. Call `jev_execution_approve({"approvalId":"exec_..."})` only after explicit approval, then recheck. Only `allowed=true`, `decision=allow`, `needsHumanReview=false` permits the checked invocation.

The approval has no periodic deadline after approval. Pending reviews expire after one hour. `jev_execution_reject` rejects a pending review; `jev_execution_revoke` revokes an approved record. Both take only `approvalId`. Rejected/revoked/superseded IDs never reactivate. An optional `executionApprovalId` on `jev_check_test` requires that exact active approval. Approval actions reread current evidence; changing evidence while approval is pending requires a new review. Approval state changes are recorded separately from code-cache decisions.

The server fingerprints the actual profile bytes, project root, entry form/fixed arguments, full script chain, runner/guards/environment files, applicable command and test policies, configured PHP/Composer executables and runtime configuration, safety-related process environment digests, Composer dependency/global metadata, and installed `vendor` bytes. It automatically tracks `.env`, `.env.testing`, `bootstrap/cache/config.php`, `tests/TestCase.php`, Composer lock/installed/autoload metadata and XML bootstrap when present, including absence-to-presence changes. Test bodies, current test-file inventories and allowed filters are excluded from execution approval identity. Changes to ordinary `codeReviewRoots` require code review; changes to any file also classified as an environment/guard input require execution reapproval. Dependency reinstall/autoload changes may therefore require execution reapproval. Provider/model changes require code reassessment but do not invalidate this execution approval. Jev connection keys remain excluded.

The server reads all selected tests before approval/cache/API use and uses the same original-byte snapshots for policy checks, fingerprints and code evaluation. Related and execution-source evidence is bounded to 64 files, 32 KiB per file, 64 KiB total and 4096 traversed entries; each v3 test file has the same 32 KiB read limit. Full-suite selection permits at most 128 test files and 4096 traversed entries. Installed dependency manifests permit 20000 files, 40000 entries and 8 MiB per file. Full serialized test requests remain limited to 256 KiB. No evidence is silently truncated or skipped to make a decision pass.

The Composer adapter accepts `composer test` or `composer run-script test`, optionally `--no-plugins` before the command, and selector arguments after `--`. Simple `@script` references are expanded (maximum depth 16, 64 handlers); exactly one PHP safe-runner leaf is required. All array entries must resolve. The leaf may use `@php`, `php`, or the configured PHP path. The Composer PHP shebang must resolve to the configured PHP; a `php` leaf must resolve to it too. No custom vendor/bin directories, PHP callback/Command handlers, event handlers, script-reference arguments, `@putenv`, `@composer`, additional-argument placement directives, shell combinations, expansion or wrappers are supported. Installed/global plugins require explicit `--no-plugins`; otherwise inspected metadata must establish their absence. The direct adapter is `"entry":{"adapter":"php-runner"}` with `php scripts/test-safe.php`. Named executables must resolve to the configured executable; use its absolute path if PATH differs. The PHP runner is an explicitly human-reviewed boundary, not automatic import or dynamic-process resolution; obvious shell/eval invocation is blocked.

Only relative PHP file selectors within `filePatterns` and one permitted `--filter VALUE` are variable. Configuration/bootstrap/PHP options and arbitrary arguments are rejected. Full-suite execution enumerates the actual XML `testsuites` files/directories; supplied `testFiles` must equal the complete selected set, never a subset. Filter-only execution still reviews every selected file. XML DTDs, exclusions, extensions and custom loaders are unsupported. Inline `testCode` and Profile v2 `execution`/`environmentApprovalId` cannot be mixed with v3. Container/remote/wrapper invocations stop; run the MCP and the direct checked invocation in the same namespace instead of checking only an inner command.

Command and test Built-in/User/Project rules apply inside this single gate. A matching execution approval clears only its own execution-condition review. The command Jev assessment runs fresh on every approved check, even on a code-cache hit; no command allow cache is read or written. Code may reuse only the existing eligible automatic allow cache. Separate command/code risks return model-bound `reviewId`/`reviewIds` and `reviewReasons`; use existing Human Review operations and recheck. Approval-derived allow never populates automatic cache. A later deny, required API failure, missing evidence, unsupported form, target mismatch or approval-store failure cannot be bypassed with execution approval or old cache.

`reviewReasons` distinguishes `execution-approval`, `command-risk`, `code-risk`, `evidence-incomplete`, and `evaluation-error`. Only reasons with `approvable=true` and a server-issued ID are approvable. Errors such as `INVALID_EXECUTION_PROFILE`, `EXECUTION_CHAIN_UNRESOLVED`, `UNSUPPORTED_EXECUTION_FORM`, `EXECUTION_TARGET_MISMATCH`, `EXECUTION_SELECTOR_OUTSIDE_SCOPE`, `EXECUTION_DEPENDENCY_INCOMPLETE`, and `EXECUTION_APPROVAL_MISMATCH` require correction and rechecking, not human override. If a project has v3 approval history, removing/downgrading its profile does not restore legacy caller-declared approval. Composer test invocations require v3 even without prior history.

Execute the same checked invocation through the existing runner. It must enforce SQLite memory, check actual connections, reject persistent/fallback/additional connections, and handle configuration cache on every run. Recheck if code, targets, command or safety conditions change. The gate does not provide OS sandboxing, filesystem locks or automatic prevention of changes between check and execution.

Migration: stop older processes and consistently back up SQLite/WAL before upgrading. Startup transactionally migrates schema 6 to 7 by adding execution-approval storage; it does not convert 30-day Environment Approvals into indefinite approvals or delete history/cache. v1/v2 evidence workflows and optional v2 Tickets remain available; migrate Composer test execution to v3 and obtain its initial execution approval. V3 code identity is separate from legacy profiles. Older servers cannot open schema 7; downgrade requires the pre-upgrade backup. Update the distributed `JEV_POLICY.md` in consuming projects along with the server.

### Legacy Safety Profiles and code-evaluation identity

Projects may define reusable test-safety evidence in `.jev/test-safety.json`. The profile is framework-neutral and declares safety-related files plus expected testing, isolation, database, and runtime conditions. A profile is not a permission or a guarantee: built-in, User, Project, and Jev `deny` decisions always win.

The listed files are fingerprinted with SHA-256. Verified state is kept outside the repository under the user Jev configuration directory (or `JEV_TEST_SAFETY_STATE_PATH`) and is never committed. `jev_check_test` remains read-only; explicit verification creates the state:

```sh
npm run verify-test-safety -- --cwd /path/to/project --input /path/to/jev-verification-input.json
```

After human verification, an unchanged profile, matching fingerprint, matching runtime context, and low-risk Jev result can return `allow` without repeating the same review. Profile changes, missing files, runner/framework changes, isolation changes, invalid profiles, policy findings, or new risks return `review` or `deny`. Do not put credentials or `.env` values in a profile or verified state.

The Jev provider and requested model are part of the code-evaluation Safety Fingerprint. Changing either invalidates old Jev allow-cache entries, Human Review matches, and code-bound Execution Tickets, so code is re-evaluated. Provider/model changes alone do not invalidate a matching Environment Approval because environment approval is kept separate from code evaluation. Legacy cache entries without provider identity are not reused. Jev connection API keys are never included in fingerprints or cache keys; rotating a connection key without changing provider/model does not itself invalidate a safety decision.

Test input identity is separate from API redaction. For `testFiles`, the code fingerprint includes the SHA-256 digest of the original bytes from the same read used for evaluation. Inline `testCode`, `diff`, and `context` are hashed before masking, newline conversion, or Unicode normalization; omitted and empty fields are distinct. The test command is hashed before masking for Human Approval and, outside Safety Profile v2/v3, for code evaluation. A change limited to a masked value still requires re-evaluation and, when needed, a new Human Review. Unchanged eligible inputs can still reuse automatic allow cache. In a multi-file request, only files affected by the change are re-evaluated unless shared safety context also changes. Profile v2 keeps code identity separate from environment and execution selection: a code-only change preserves a matching Environment Approval, and an allowed filter-only change can reuse code evaluation.

Original input is used in memory for change detection; this identity adds only digests, never plaintext, to fingerprints. The API still receives masked input, and individual field digests are not added to API payloads or MCP responses. Hashing is not encryption or a guarantee against guessing low-entropy content. Credentials embedded in evaluated code or test arguments affect its digest, unlike the server's Jev connection credentials.

The earlier `raw-test-input-v1` evaluator update changed input identity without a DB migration. The current release uses schema 7. Stop old server processes and restart with the updated build. Earlier cache and Human Review records remain as history but cannot match the new evaluator/input identity; recheck and obtain a new Human Review when required. Audit history and matching Environment Approvals are preserved. Previously issued Execution Tickets do not match newly computed code fingerprints; obtain a new ticket through `jev_check_test` before using the updated runner's current fingerprint checks. Do not run an older evaluator against the shared cache, since it can still recognize old entries.

When upgrading from SQLite schema 5 or earlier, stop old server processes and back up the cache database (`cache/jev.sqlite`, or `JEV_CACHE_DB_PATH`) before starting the updated server. Back up SQLite consistently, including outstanding WAL data. Startup automatically migrates through schema 6 to schema 7 in a transaction: all existing allow-cache entries are retained but made non-reusable because approval-derived entries cannot reliably be distinguished. Old Human Reviews remain as history but do not match the new model-bound approval fingerprint; checks requiring approval need a new review. Audit history and matching Environment Approvals are preserved. Code evaluation uses a new evaluator version. Expect one-time re-evaluation, and potentially new Human Reviews. Migration failure rolls back the changes; the database is never deleted automatically. Older servers cannot open schema 7; downgrading requires restoring the pre-upgrade backup.

The server only evaluates supplied evidence; it does not inspect a live process, connect to a database, or prove that runtime claims are truthful.

#### Optional legacy Safety Profile v2 and Environment Approval

Profile v2 separates the human-approved execution environment from test code reviewed on each change. Changes to `environmentFiles` or the runner require new environment approval. Tests, assertions, permitted file selectors, and filters do not. File additions, deletions, or original-byte changes under `codeReviewRoots` invalidate the matching code-review cache and Human Approval, but preserve an otherwise matching Environment Approval.

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

With Profile v2, pass a structured `execution` selecting the same files as `testFiles`. `command` names only the project-relative approved runner; targets and filters are not appended to a shell command.

For each check, the server reads the full current UTF-8 contents of every file under `codeReviewRoots`, deduplicating overlapping roots. The same in-memory snapshot supplies original-byte digests, Built-in/User/Project Policy and framework checks, and masked `relatedCode` (`file`, `content`) sent to Jev. Multiple `testFiles` in one request share that snapshot. Related findings optionally include the project-relative `file`. Raw source contents are not stored in SQLite, logs, or MCP results; only masked contents leave the server. Masking is best-effort: inspect the configured scope for sensitive material before use.

Review limits are 64 related files, 32 KiB per file, 64 KiB total original bytes, 4096 traversed entries (including directories), and 256 KiB for the complete serialized Jev request. Missing/unreadable paths, symlinks (including parent components), non-regular files, binary/non-UTF-8 contents, or exceeded limits stop with `RELATED_CODE_REVIEW_INCOMPLETE`, `decision=review`, and `allowed=false`. Nothing is silently truncated or skipped by extension. There is no approvable `reviewId`, cache/Human Approval bypass, or Execution Ticket; fix the scope/readability or request size and recheck. An already detected static `deny` remains `deny`. Related-review failure alone does not invalidate a matching Environment Approval.

The review scope is the supplied tests plus explicitly configured `codeReviewRoots`; imports, packages, and dynamic dependencies are not automatically expanded. `codeReviewRoots: []` is valid but specifies no additional source review, not complete dependency safety. Select an appropriate scope within these limits (large `app` directories or `composer.lock` files in the example may exceed them); never remove relevant files solely to bypass a blocked review. Runner-side resource and fingerprint enforcement remains necessary.

Migration: the `related-code-v1` evaluator update prevents reuse of earlier code caches and Human Reviews without itself changing the DB schema. Restart/rebuild the updated server, recheck, obtain new Human Approval if requested, and use a fresh Execution Ticket only for the optional Profile v2 Ticket path. Audit/review history and matching Environment Approvals are retained. Existing Profile v2 configurations must meet the new review limits; input arguments and profile format are unchanged.

The first check returns `environmentReviewId` and `decision=review`. After a human checks the runner and resource scope, pass only that ID to `jev_environment_approve`. Approval lasts 30 days by default and can be immediately revoked with `jev_environment_revoke`.

An approved environment plus static and Jev allow returns a single-use, five-minute Execution Ticket. The safe runner must recheck current environment/code/execution fingerprints, the effective database connection, config cache, fallback/additional connections, filesystem, and network immediately before consuming it. MCP allow and caller-supplied evidence do not replace runtime enforcement.

## Safety and privacy

- Does not execute commands or tests, or connect to databases.
- Does not trust command input or follow instructions contained in it.
- Masks common tokens, passwords, secrets, and API keys before sending input to Jev.
- Does not output Cloudflare tokens or TypeSafe API keys to logs, MCP responses, fingerprints, or caches.
- Returns `review` fail-closed when the Jev API is unavailable, the response is invalid, or a policy cannot be loaded.
- Does not automatically retry through or fail over to a different provider. A static or project-policy `deny` remains `deny` during API failures, while an API failure with no existing deny returns `review` and cannot be bypassed by an earlier Human Approval.
- This tool is not a complete shell parser or execution-environment audit. Command checks require `review` for unsupported syntax and unreviewed scripts; even supported direct commands do not verify executable resolution or runtime resources.

## Development

```sh
npm run typecheck
npm test
```

`npm run test:laravel` builds a dedicated Podman PHP/Composer/Node image, installs the fixture dependencies into a disposable temporary project, and then runs the gate plus Laravel/PHPUnit without network access or host database mounts. It checks Ticket-free execution, continuing approval, actual SQLite memory, persistent/fallback rejection, config-cache restoration, and direct-runner bypass rejection. It requires Podman and network access for image/dependency preparation; no PHP installation on the host is needed. The fixture project is deleted after the run.

`npm test` runs the repository's unit tests. Commands evaluated in the tests are passed to a mocked Jev as input only; they are not executed.

## License

MIT License

## Disclaimer

This software is provided as a safety-assistance tool and does not guarantee that commands, code, or operations determined to be safe are actually safe.

The results produced by Jev and this MCP server may contain false positives, false negatives, errors, or incomplete assessments. Always review important or destructive operations yourself before execution, especially in production environments.

The authors and contributors are not responsible for any data loss, system failure, service interruption, security incident, financial loss, or other damages arising from the use or misuse of this software.

Use this software at your own risk.
