## Jev Safety Gate

This project uses the `jev-mcp-server` MCP server as a safety gate for potentially destructive operations.

### Command execution

For test invocations, follow the Tests procedure below and use `jev_check_test` alone. Before executing other commands that may modify files, repositories, databases, dependencies, services, containers, infrastructure, deployments, or other persistent state, call:

`jev_check_command`

Provide the exact command that will be executed and, when available, relevant context such as:

- working directory (`cwd`)
- environment (`development`, `testing`, `staging`, `production`, or `unknown`)
- target of the operation
- relevant safety context

Do not replace the actual command with a simplified or partial version when requesting the safety check.

### Decision handling

Only execute the checked command when:

- `allowed=true`
- `decision=allow`
- `needsHumanReview=false`

If the result is:

- `decision=review`
- `decision=deny`
- `allowed=false`
- `needsHumanReview=true`

do not execute the command.

For `review`, explain the identified risk to the user. If `jev_check_command` returns a `reviewId`, call `jev_review_approve` with only that ID after explicit human approval, then repeat the exact check and continue only if it returns `allow`. If there is no `reviewId`, the result is not approvable; correct the missing evidence or failure and recheck. Never execute directly from a `review` result or a successful approval-tool response.

For `deny`, do not execute the command. Explain why it was blocked and propose a safer alternative when possible.

### Fail closed

If `jev_check_command` cannot complete successfully, do not assume the command is safe.

This includes:

- MCP unavailable
- selected Jev provider API (Cloudflare or TypeSafe AI) unavailable
- timeout
- invalid response
- policy loading failure
- insufficient context for a safety decision

Treat these conditions as requiring human review.

Do not switch providers, infer a provider from available credentials, or retry through a different provider after failure. If a static, Built-in, User, or Project Policy already returned `deny`, preserve that `deny`; otherwise an API error, authentication error, timeout, or invalid response requires `review`. A previous Human Approval must not be used to bypass a failed current Jev evaluation.

Do not bypass or retry around the safety gate by changing the spelling, shell syntax, command structure, execution method, or tool solely to avoid a `review` or `deny` decision.

### Command integrity

The command executed must be materially identical to the command approved by `jev_check_command`.

If the command, arguments, target, working directory, environment, shell pipeline, redirection, or execution context changes after approval, run `jev_check_command` again.

For compound commands, pipelines, command substitutions, scripts, or commands using `&&`, `||`, `;`, pipes, redirects, wildcards, recursive options, or force options, provide the complete command to the safety check.

### Command review scope and cache

`jev_check_command` does not reuse allow-cache entries for any provider/model. Once input and policy validation succeed, each check without a static `deny` evaluates Jev again. Old command cache rows are history only; test-cache behavior is unchanged.

A supported direct command may return a one-hour `reviewId` when current static/Jev analysis requires review and the API reports a versioned actual model. Present the exact command, project, target, environment, context, findings, and impact to the human. After explicit approval, call `jev_review_approve` with only the server-issued ID and recheck the exact input. Approval matches the raw command input, resolved project, current Policy, and actual model. Any change requires a new review. A subsequent deny or evaluation failure always wins. Approval never skips the fresh Jev call or creates a command allow-cache entry.

The supported scope is simple `ls`, `cat`, `mkdir`, `rmdir`, `touch`, `cp`, `mv`, `rm`; `pwd` with only optional `-L`/`-P`; `git status` with the limited options documented in the README; and `git diff --no-ext-diff --no-textconv` with the documented options and paths after `--`. Tokens use only ASCII letters/digits and `_./:=+-`, separated by spaces/tabs. Quotes, escapes, newlines, shell operators/expansion, wrappers, unknown executables, and unsupported Git options/subcommands require review. This classification does not verify PATH, aliases/functions, binary integrity, Git configuration (including fsmonitor), or runtime resources. Use the README's exact supported syntax; never infer support from a similar command.

When `staticFindings` contains `command.execution-content-unreviewed`, stop. Script bodies, dependency/configuration contents, or dynamic execution have not been evaluated. Scripts such as `node task.js`, `python task.py`, `./task.sh`, and dispatchers such as `npm run`, `make`, or `composer run-script` remain `review` even after a low-risk Jev result. No command `reviewId` is issued for these results. Do not call `jev_review_approve`, add an allow policy, put code/approval claims in `context`, or treat human approval alone as clearing missing evidence. Static/Jev `deny` still wins. Never simplify or rewrite a command solely to evade this condition.

Recheck when script bodies, related configuration/dependencies, or other execution inputs change, even if the command string is unchanged. Checks do not lock files or enforce execution-time integrity; preserve the checked inputs through execution.

After the command Human Review update, stop old server processes, rebuild/restart the updated server, and recheck. It uses the existing schema 8 `human_reviews` table and does not require a new DB migration. Earlier command results are not approvals; obtain a new server-issued `reviewId`. Existing history and test approvals remain available. Never use an older server or old command result to bypass the current review conditions.

### Read-only operations

Clearly read-only inspection commands may be executed without a Jev check when they cannot reasonably modify persistent state.

Examples include:

- `git status`
- `git diff`
- `pwd`
- `ls`
- reading files
- version checks

If there is uncertainty about whether an operation is read-only, use `jev_check_command`.

### Tests

Use `jev_check_test` to evaluate any test command that may interact with databases, filesystems, external services, networks, credentials, production resources, or other persistent state. `jev_check_test` is language- and framework-independent; use `framework` when known, such as `laravel`, `vitest`, `pytest`, `rspec`, `go`, or `cargo`.

Provide the exact command and, when available, `cwd`, `environment`, `framework`, `testCode`, `diff`, and `context`. For multiple test files, provide `testFiles` when supported. Each file is evaluated and cached independently; do not combine unrelated test files into one large `testCode` value. Prefer structured evidence for isolation and runtime access:

#### Test paths and container mounts

`cwd` is the project root used by the `jev-mcp-server` process to read policies, Safety Profiles, test files, and related files. It must be a real directory in the MCP server's filesystem namespace. It is not necessarily the directory used inside the test execution environment.

When tests run in a container, VM, or remote environment:

- keep `command` identical to the command that will actually run, including paths inside that execution environment;
- set `cwd` to the corresponding host, WSL, or MCP-visible project root;
- specify `testFiles` relative to that `cwd` whenever possible;
- do not use container-internal absolute paths for `cwd` or `testFiles` unless the MCP server runs in that same container and can read them directly;
- verify that the MCP-visible directory and the execution directory refer to the same project contents.

For the normal DB workflow, keep `cwd` on the host and register the human-confirmed container path mapping. After initial registration/approval, use the exact server-issued condition ID (replace the example placeholder):

```json
{
  "command": "podman exec showa-pdoso sh -lc 'cd /var/www/vhosts/kamoi/kamoi-ds && composer test'",
  "cwd": "/var/docker/showa-pdoso/vhosts/kamoi/kamoi-ds",
  "framework": "laravel",
  "environment": "testing",
  "executionConditionsId": "cond_SERVER_ISSUED_ID"
}
```

An absolute `testFiles` entry is valid only when it resolves inside `cwd` in the MCP server's filesystem. Making a container-only path absolute does not make it readable by the MCP server. If the MCP server cannot read a requested test file, treat the check as failed rather than substituting a description of the file.

If `jev_check_test` returns `isError=true` with `TEST_CWD_NOT_FOUND`, `TEST_CWD_NOT_DIRECTORY`, `TEST_CWD_UNREADABLE`, or `TEST_FILE_VALIDATION_ERROR`, do not request Human Review and do not execute the test. Inspect `fileErrors` when present, correct the MCP-visible `cwd`, mount, or file paths, and run `jev_check_test` again. Never call `jev_review_approve` for these input errors; they do not have an approvable `reviewId`.

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

After preparing the test input:

1. Call `jev_check_test` with the exact command, actual target files and required execution evidence.
2. Resolve only server-issued, approvable reviews after explicit human direction, then recheck.
3. Execute the same checked invocation only when `allowed=true`, `decision=allow`, and `needsHumanReview=false`.

Do not add a second `jev_check_command` for test execution. Use it for other operations such as dependency installation, database administration or cleanup.

#### DB-registered execution approval

Use the exact complete command and host-readable project root with `jev_check_test` alone. The normal Laravel/Composer/PHP runner path uses structured `executionConditions` and the Jev DB, not a Profile file. Follow README's initial local/Podman/Docker examples. Complete only fields reported in `missingFields`; never create `.jev/test-safety.json` to solve a registration error. Existing safe runner and connection guards remain mandatory; no Ticket SDK or new isolation mechanism is required.

On `executionReviewId`, present `executionApproval.scope`, registration ID, host/container path correspondence, exact entry and fixed arguments, expanded Composer chain, full PHP runner, guard loading, PHPUnit invocation, selector forwarding and resource/argument scope. After explicit human approval, call `jev_execution_approve` with only that returned `approvalId`, then recheck. Pending candidates and AI declarations are not approved registrations. Only `allowed=true`, `decision=allow`, `needsHumanReview=false` permit the checked invocation. If tests have not run, report this as a safety assessment, not a test result.

Later calls can select `executionConditionsId` or require an exact `executionApprovalId`; use only server-issued IDs and retain the actual command/targets. IDs are still matched against project and current conditions. With multiple matching registrations, inspect `conditionCandidates` and specify the intended ID, never choose an arbitrary record. Changed scope must be supplied without old IDs for a new registration/review. Different containers/scopes may coexist. Approved records have no periodic deadline; pending records expire in one hour. `jev_execution_reject` rejects pending records; `jev_execution_revoke` cancels approved records. Rejected, revoked, expired and superseded IDs never reactivate; evidence is reread during approval too.

The container mode trusts conditions explicitly approved by a human. Keep the host root in top-level `cwd` and the container name/projectRoot/workdir in `executionConditions.target`. Container workdir must remain within projectRoot; its relative subdirectory maps below the host root. Entry/configuration/selectors are workdir-relative, while testFiles is host-project-relative. The outer exec target and the complete inner command are checked. Support is limited to direct `exec --workdir|-w` or `exec name sh -lc 'cd /root && ENTRY'` with only that cd and one entry. Additional commands, expansion, unknown exec options and runner bypass stop. Never submit only the inner Composer command for an outer command that will actually execute.

Do not require inspect, mount/image/container-ID tracking, an internal collector, MCP relocation, or container runtime/vendor inspection. Do not inspect container PHP/Composer paths as host files. Recreating the same-named container or internal image/mount changes alone do not require updating DB registration or reapproval. Explain that `sourceVerification=human-approved-container` and `containerInternalsVerified=false` mean a human-approved assumption, not automatic container verification. Local direct execution retains executable/runtime/dependency checks. Required host-readable sources/guards/configuration and current code must still be readable and complete.

The existing runner must enforce SQLite memory, handle/restore configuration cache, inspect actual DB connections and reject persistent/fallback/additional connections every run. Neither a declaration, source reference nor an AI isolation claim proves enforcement. Review the complete existing runner and guards initially; do not demand a new runner SDK.

For DB execution and explicit legacy Profile v3, `runner.safetyFiles` must identify the connection guard source; place PHPUnit XML and `.env.testing` in `environmentFiles`. Direct filename mentions in the runner are not required and do not prove execution. Guard files must remain complete, readable, regular, symlink-free source with original-byte change detection. Never substitute dependency metadata or caller `context` for guard source. Before execution approval, inspect the actual PHPUnit bootstrap, Composer autoload mapping and test inheritance; confirm coverage of selected tests, ordering before DB access and rejection of persistent/fallback/additional connections. Include all necessary files in the declared scope. `runnerVerification.guardLoadingVerified`, `guardApplicabilityVerified` and `resourceIsolationVerified` are all false: do not present syntax/local-runtime checks as proof of these properties. If the actual path or resource enforcement cannot be confirmed, stop without approving.

Review `executionApproval.scope.runnerVerification.processInvocations` against the complete runner. Supported `passthru` uses `escapeshellarg(PHP_BINARY)` plus an exact literal PHPUnit entry or ` artisan config:clear`; selector forwarding must use spaces plus `escapeshellarg` in a `foreach` over unmodified `array_slice($argv, 1)`. Supported `proc_open` uses a fixed PHP_BINARY argv array and, for PHPUnit only, the validated selector array. Unsupported command construction/aliases/scopes, raw concatenation, arbitrary commands/options, string-based `proc_open`, `eval`, backticks and other shell execution functions stop with non-approvable `EXECUTION_CHAIN_UNRESOLVED`; do not approve around that error. Prefer argv arrays for new runners. Supported syntax still requires explicit execution approval and current command/code/Policy checks. Verify exit handling, selector constraints and cache restoration yourself.

`artisan config:clear` starts Laravel before the test guard. Its recognized use adds `artisan` and `bootstrap/app.php` to review/change detection and lists them in `preparationFiles`; missing/incomplete files block execution. Review additional startup/configuration dependencies and pre-test DB access/side effects. Do not infer that a `tests/TestCase.php` guard protects this stage. After this update, install updated dependencies, rebuild/restart and recheck; verifier versions `jev-db-execution-v2` and `jev-test-execution-v2` require a new explicit execution approval of the revised scope. Older code caches/Human Reviews cannot bypass the new evaluator. DB schema/input format and histories remain; legacy v1/v2 behavior is unchanged. If correcting guard/environment fields creates another matching registration, use its returned `executionConditionsId`. Do not edit a project's runner or run PHPUnit solely because the server was updated.

Permitted test additions/body changes and file/filter selection changes reuse matching execution approval. Review affected code and related code, or reuse only the existing eligible fixed-model-safe code cache. Ordinary related-code changes affect code review alone. Execution definitions, runner, guard, bootstrap/safety settings, registered conditions, local runtime/dependencies and Policy changes require reapproval. Digests come from original bytes and pre-mask input; never use caller hashes or mask equality as proof. Do not expose raw secret values in change explanations or save them in registration/context logs. Missing/deleted/malformed Profile files do not affect normal DB registration or its code-cache identity.

Use only approved relative PHP files and one allowed literal `--filter VALUE` after Composer `--`. `testFiles` must equal the entire selection; full-suite commands require the whole XML-resolved suite. A filter still reviews the full selected files. Do not use selectors to change PHP options, configuration or bootstrap. Omit inline `testCode` and legacy `execution`/`environmentApprovalId` on the DB path. Include all necessary helper/application sources and safety settings; do not shrink roots, exclude files or truncate source to evade read limits. The server does not resolve all dynamic PHP imports/processes. Existing read/traversal/request limits are documented in README.

Inspect `reviewReasons`: `execution-approval` uses execution approval; `command-risk`/`code-risk` use their separate actual-model-bound Human Review IDs. `registration-incomplete`, `conditions-ambiguous`, `conditions-mismatch`, `unsupported-form`, `evidence-incomplete`, `evaluation-error` and `approvable=false` require correction. Use `missingFields`, `conditionCandidates`, `evidenceErrors` and `fileErrors` for exact items/files and next steps. Another approved reason never resolves a remaining error. Static/Policy/Jev deny, unresolved reviews and API/DB/read failures cannot be bypassed by registration or cache.

Every approved test check still evaluates the whole command with Jev, including code-cache hits. General command allow caching stays disabled. Provider/model changes affect code/command review, not environment approval by themselves. Recheck after any changed code or matching conditions; run only the checked command/targets. This gate does not automatically provide an OS sandbox or prevent changes between check and execution.

Upgrade to schema 8 with a consistent SQLite/WAL backup and updated server/policy. Preserve old history and cache; no legacy Profile approval is automatically converted into a DB approval. Supply executionConditions and obtain the new initial confirmation/approval before removing the old Profile. Explicit `safetyProfilePath` selects optional legacy local v3 or v1/v2 compatibility; do not mix it with DB conditions/IDs. An old Profile approval ID without that explicit path requires migration. Legacy v2 Tickets remain optional under their documented conditions, and no old server/evaluator/approval may bypass current checks.

#### Human Review for tests

When `jev_check_test` returns `decision=review`, `allowed=false`, `needsHumanReview=true`, and a `reviewId`, present the reason and relevant safety context to the user and ask for explicit approval. If the user explicitly approves the exact test, call `jev_review_approve` with only the returned `reviewId`; never invent or supply `approved`, `fingerprint`, `command`, `testFiles`, or `projectId` fields. If the user declines, call `jev_review_reject` with the `reviewId` when appropriate.

After approval, call `jev_check_test` again with the exact same command, test files, working directory, policy context, and runtime/isolation evidence. Execute the test only if the new result has `allowed=true`, `decision=allow`, and `needsHumanReview=false`. An approval is tied to the server-issued review, project, command, test files, Safety Fingerprint, Policy, Safety Profile, and runtime context. Any safety-relevant change invalidates the old approval and requires a new review. A rejected, expired, unknown, or cross-project review ID cannot be used.

Human Review never overrides `deny` from Static Check, Jev, Built-in Policy, User Policy, or Project Policy. Do not execute a test merely because `jev_review_approve` succeeded; the final `jev_check_test` result is required.

Human Reviews expire one hour after creation; approval does not extend the deadline. Human Approval never creates a reusable allow-cache entry. Checks requiring approval evaluate Jev again before matching the approval's status, expiry, full safety context, and API-reported actual model. Present `jevProvider`, `requestedModel`, and `actualModel` with the review context. The server's approval fingerprint includes the code fingerprint and exact command/files/cwd context plus actual model; do not equate it with `codeAssessment.fingerprint`. A changed actual model requires a new Human Review when approval is still needed, even if the requested alias is unchanged. Expired pending or approved reviews require a newly issued review ID and new explicit approval.

For `jev_check_test`, only pinned TypeSafe `jev-X.Y.Z` models whose actual model matched the requested model may reuse automatic allow-cache entries. TypeSafe moving aliases and Cloudflare `typesafe/jev` call the API whenever Jev evaluation is required. If `JEV_MODEL_ID_UNVERIFIED` is returned, stop: there is no approvable `reviewId`. Correct the provider/model reporting and recheck. Never use an earlier approval to bypass API failure or a later `deny`.

After upgrading to SQLite schema 6, old cache entries are non-reusable and old Human Reviews are history only. Obtain a newly issued Human Review and explicit approval when required; do not try to reuse an old review ID. Audit history and matching Environment Approvals are preserved, and provider/model changes alone do not require new Environment Approval.

`jev_check_test` may return `decision=allow` from an unchanged eligible automatic Safety Fingerprint Cache entry or from a valid model-bound Human Approval. This is still subject to the same `allowed` and `needsHumanReview` checks. Cache hits and Human Review decisions are stored in the server's SQLite database for audit. A code-cache hit does not mean code was sent to Jev in that request; DB-registered execution and legacy Profile v3 still evaluate the command with Jev. Changes to the command, test file, shared safety files, policies, Safety Profile, working directory/project, runtime/isolation evidence, evaluator version, Jev provider, or requested model invalidate reuse and cause code re-evaluation. Cache entries without provider identity are not reusable. Jev connection API keys are not fingerprint inputs.

API redaction does not establish input identity. Test files are identified by original-byte digests, and inline `testCode`, `diff`, `context`, and applicable test commands are hashed before redaction. Changes limited to masked values still require a new `jev_check_test`; do not assume unchanged masked API text permits cache or Human Approval reuse. If the new result requires Human Review, obtain a newly issued review ID and explicit approval. Do not send or log plaintext secrets to demonstrate what changed. Jev connection credentials remain excluded, but credentials inside evaluated code or test arguments affect its digest. A test-code-only change preserves a matching Profile v2 Environment Approval; permitted filter-only changes may reuse code evaluation.

After the `raw-test-input-v1` evaluator update, earlier cache and Human Review records do not match the new identity without itself changing the DB schema. Recheck, obtain a new Human Review when required, and obtain a new Execution Ticket for current code fingerprints only for the optional Profile v2 Ticket path. Audit history and matching Environment Approvals are preserved. Use the updated server; do not fall back to an older evaluator or an old review/ticket to bypass re-evaluation.

For Laravel, set `framework` to `laravel`. Existing Laravel evidence fields such as `runtimeDatabase`, `configCache`, `runtimeGuard`, and `persistentDatabaseAccess` remain supported. `RefreshDatabase`, `DatabaseMigrations`, `DatabaseTruncation`, `migrate:fresh`, `db:wipe`, persistent database targets, and test/runtime configuration mismatches must be treated as safety findings.

Never assume a test environment is isolated solely because a test configuration file, `.env.testing`, documentation, or environment name indicates that it is a test environment.

For a Safety Profile v2 project, pass only the approved runner as `command` and pass test targets through the structured `execution` object. If `jev_check_test` returns an `environmentReviewId`, show the exact runner and resource scope to the user and call `jev_environment_approve` only after explicit human approval. Environment Approval does not approve test code, policy findings, or Jev findings. A provider/model change requires code re-evaluation but does not, by itself, invalidate an otherwise matching Environment Approval.

For both DB-registered conditions and legacy Profiles, `composer.lock` is JSON text, but its full body is dependency metadata, not source submitted for review. Regular files with this exact basename (including nested paths), whether specified explicitly or found under `codeReviewRoots`, are excluded from both command evidence bodies and `relatedCode` sent to Jev. Only the project-relative path, original-byte SHA-256 digest and byte count are retained for change detection.

They do not consume the source limits of 64 files, 32 KiB per file or 1024 KiB total; metadata has separate bounds of 64 files and 8 MiB per file and shares the 4096-entry traversal bound. Missing/unreadable files, symlinks and non-regular files still block the check. Other lockfiles receive no exemption. Local Composer plugin inspection still reads the JSON locally; this does not inspect container internals. `composer.lock` cannot be submitted through `testFiles` (`TEST_FILE_METADATA_ONLY`).

Existing DB registrations and legacy Profiles that include it need no edits. Lock changes still invalidate applicable code identities and, when part of execution conditions or automatic dependency detection, require renewed execution approval. Rebuild/restart and recheck after this update: `related-code-v2` invalidates earlier code caches/Human Reviews without a DB schema change; matching execution/environment approvals are retained.

For Profile v2, confirm that `codeReviewRoots` covers the relevant helpers, setup, and application code. The server inspects full current source contents (excluding metadata-only `composer.lock`), not just manifests or diffs, using one deduplicated snapshot for all test files in the request. It applies Built-in/User/Project Policy and framework checks to raw contents and sends masked `relatedCode` (`file`, `content`) to Jev. Related findings may include a project-relative `file`. Original-byte changes, additions, and deletions invalidate matching code caches and Human Approval; do not infer unchanged identity from identical masked text. Raw contents are not retained in SQLite, logs, or MCP results. Masking is best-effort; independently check the scope for sensitive material.

The 1024 KiB snapshot read budget is separate from the 256 KiB complete serialized code-request limit; a readable snapshot can still be too large to submit. No automatic splitting or truncation is performed.

The limits are 64 related files, 32 KiB per file, 1024 KiB total original bytes, 4096 traversed entries including directories, and 256 KiB for the complete serialized Jev request. Missing/unreadable paths, parent or leaf symlinks, non-regular files, binary/non-UTF-8 contents, and exceeded limits return `RELATED_CODE_REVIEW_INCOMPLETE`, `decision=review`, `allowed=false`. Stop: there is no approvable `reviewId` or Execution Ticket. Do not call `jev_review_approve`, reuse an old approval/cache, truncate evidence, skip extensions, or remove relevant roots to evade this condition. Explain the reason, correct readability/scope/request size, and recheck. An already detected static `deny` stays `deny`. Related-review failure alone does not revoke a matching Environment Approval.

Only the supplied tests and explicit `codeReviewRoots` are in scope; the server does not automatically resolve imports, packages, or dynamic dependencies. An empty roots list specifies no additional review and must not be interpreted as proof of dependency safety. Large source directories may exceed the limits; `composer.lock` uses the separate metadata bounds. The `related-code-v2` evaluator invalidates older code caches/Human Reviews without itself changing the DB schema. Use the updated server, re-evaluate, obtain new explicit Human Approval when requested, and obtain a new Execution Ticket only for the optional Profile v2 Ticket path; history and matching Environment Approval remain available. Never revert the evaluator or use an old review/ticket to avoid this check.

Only when explicitly using the optional legacy Profile v2 Ticket path and an allow result contains an Execution Ticket, invoke its approved safe runner. The runner must validate and consume the ticket after rechecking current environment, code, and execution fingerprints, effective database connections, config cache, fallback/additional connections, filesystem, network, and credentials. Source review does not prove actual runtime resources or the absence of fallback access. Never treat the ticket as permission to execute the raw `command` through a shell.

### Project policies

Respect all built-in, user, and project policies used by `jev-mcp-server`.

Project-specific rules may be defined in:

`.jev-policy.json`

Safety policies may make the default rules stricter. Do not attempt to override, weaken, or circumvent a stricter safety decision.

### Important

`jev-mcp-server` is an additional safety layer, not a replacement for engineering judgment.

Before high-impact operations, independently verify the target and expected effects even when Jev returns `allow`.
