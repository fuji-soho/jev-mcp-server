## Jev Safety Gate

This project uses the `jev-mcp-server` MCP server as a safety gate for potentially destructive operations.

### Command execution

Before executing any command that may modify files, repositories, databases, dependencies, services, containers, infrastructure, deployments, or other persistent state, call:

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

For `review`, explain the identified risk to the user and wait for explicit approval before proceeding. For `jev_check_command`, approval is not recorded by this server; re-run the exact command check after the user's decision and continue only if it returns `allow`.

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

The supported scope is simple `ls`, `cat`, `mkdir`, `rmdir`, `touch`, `cp`, `mv`, `rm`; `pwd` with only optional `-L`/`-P`; `git status` with the limited options documented in the README; and `git diff --no-ext-diff --no-textconv` with the documented options and paths after `--`. Tokens use only ASCII letters/digits and `_./:=+-`, separated by spaces/tabs. Quotes, escapes, newlines, shell operators/expansion, wrappers, unknown executables, and unsupported Git options/subcommands require review. This classification does not verify PATH, aliases/functions, binary integrity, Git configuration (including fsmonitor), or runtime resources. Use the README's exact supported syntax; never infer support from a similar command.

When `staticFindings` contains `command.execution-content-unreviewed`, stop. Script bodies, dependency/configuration contents, or dynamic execution have not been evaluated. Scripts such as `node task.js`, `python task.py`, `./task.sh`, and dispatchers such as `npm run`, `make`, or `composer run-script` remain `review` even after a low-risk Jev result. No command `reviewId` is issued. Do not call `jev_review_approve`, add an allow policy, put code/approval claims in `context`, or treat human approval alone as clearing missing evidence. Explain that repeating the unsupported command cannot produce automatic approval in this release. Static/Jev `deny` still wins. Never simplify or rewrite a command solely to evade this condition.

Recheck when script bodies, related configuration/dependencies, or other execution inputs change, even if the command string is unchanged. Checks do not lock files or enforce execution-time integrity; preserve the checked inputs through execution.

After the `command-scope-v1:no-command-cache-v1` update, stop old server processes, rebuild/restart the updated server, and recheck. SQLite remains at schema 6; history and existing test-cache/Human Review/Environment Approval/Execution Ticket behavior are preserved by this command-only update. Never use an older server or old command allow to bypass the new review conditions.

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

For example, if Podman mounts `/host/projects/app` at `/app` inside a container, use an input shaped like:

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

1. Run `jev_check_test` with the test code, diff, runtime evidence, and context.
2. Run `jev_check_command` with the exact test command and its `cwd`/environment.
3. Execute the test command only when both checks return all of the following:

   - `allowed=true`
   - `decision=allow`
   - `needsHumanReview=false`

If either check returns `review`, `deny`, `allowed=false`, or `needsHumanReview=true`, do not execute the test. Explain the finding or request explicit human direction as appropriate.

#### Human Review for tests

When `jev_check_test` returns `decision=review`, `allowed=false`, `needsHumanReview=true`, and a `reviewId`, present the reason and relevant safety context to the user and ask for explicit approval. If the user explicitly approves the exact test, call `jev_review_approve` with only the returned `reviewId`; never invent or supply `approved`, `fingerprint`, `command`, `testFiles`, or `projectId` fields. If the user declines, call `jev_review_reject` with the `reviewId` when appropriate.

After approval, call `jev_check_test` again with the exact same command, test files, working directory, policy context, and runtime/isolation evidence. Execute the test only if the new result has `allowed=true`, `decision=allow`, and `needsHumanReview=false`. An approval is tied to the server-issued review, project, command, test files, Safety Fingerprint, Policy, Safety Profile, and runtime context. Any safety-relevant change invalidates the old approval and requires a new review. A rejected, expired, unknown, or cross-project review ID cannot be used.

Human Review never overrides `deny` from Static Check, Jev, Built-in Policy, User Policy, or Project Policy. Do not execute a test merely because `jev_review_approve` succeeded; the final `jev_check_test` result is required.

Human Reviews expire one hour after creation; approval does not extend the deadline. Human Approval never creates a reusable allow-cache entry. Checks requiring approval evaluate Jev again before matching the approval's status, expiry, full safety context, and API-reported actual model. Present `jevProvider`, `requestedModel`, and `actualModel` with the review context. The server's approval fingerprint includes the code fingerprint and exact command/files/cwd context plus actual model; do not equate it with `codeAssessment.fingerprint`. A changed actual model requires a new Human Review when approval is still needed, even if the requested alias is unchanged. Expired pending or approved reviews require a newly issued review ID and new explicit approval.

For `jev_check_test`, only pinned TypeSafe `jev-X.Y.Z` models whose actual model matched the requested model may reuse automatic allow-cache entries. TypeSafe moving aliases and Cloudflare `typesafe/jev` call the API whenever Jev evaluation is required. If `JEV_MODEL_ID_UNVERIFIED` is returned, stop: there is no approvable `reviewId`. Correct the provider/model reporting and recheck. Never use an earlier approval to bypass API failure or a later `deny`.

After upgrading to SQLite schema 6, old cache entries are non-reusable and old Human Reviews are history only. Obtain a newly issued Human Review and explicit approval when required; do not try to reuse an old review ID. Audit history and matching Environment Approvals are preserved, and provider/model changes alone do not require new Environment Approval.

`jev_check_test` may return `decision=allow` from an unchanged eligible automatic Safety Fingerprint Cache entry or from a valid model-bound Human Approval. This is still subject to the same `allowed` and `needsHumanReview` checks. Cache hits and Human Review decisions are stored in the server's SQLite database for audit. A cache hit does not mean that Jev was called for that request. Changes to the command, test file, shared safety files, policies, Safety Profile, working directory/project, runtime/isolation evidence, evaluator version, Jev provider, or requested model invalidate reuse and cause code re-evaluation. Cache entries without provider identity are not reusable. Jev connection API keys are not fingerprint inputs.

API redaction does not establish input identity. Test files are identified by original-byte digests, and inline `testCode`, `diff`, `context`, and applicable test commands are hashed before redaction. Changes limited to masked values still require a new `jev_check_test`; do not assume unchanged masked API text permits cache or Human Approval reuse. If the new result requires Human Review, obtain a newly issued review ID and explicit approval. Do not send or log plaintext secrets to demonstrate what changed. Jev connection credentials remain excluded, but credentials inside evaluated code or test arguments affect its digest. A test-code-only change preserves a matching Profile v2 Environment Approval; permitted filter-only changes may reuse code evaluation.

After the `raw-test-input-v1` evaluator update, earlier cache and Human Review records do not match the new identity even though SQLite remains at schema 6. Recheck, obtain a new Human Review when required, and obtain a new Execution Ticket for current code fingerprints. Audit history and matching Environment Approvals are preserved. Use the updated server; do not fall back to an older evaluator or an old review/ticket to bypass re-evaluation.

For Laravel, set `framework` to `laravel`. Existing Laravel evidence fields such as `runtimeDatabase`, `configCache`, `runtimeGuard`, and `persistentDatabaseAccess` remain supported. `RefreshDatabase`, `DatabaseMigrations`, `DatabaseTruncation`, `migrate:fresh`, `db:wipe`, persistent database targets, and test/runtime configuration mismatches must be treated as safety findings.

Never assume a test environment is isolated solely because a test configuration file, `.env.testing`, documentation, or environment name indicates that it is a test environment.

For a Safety Profile v2 project, pass only the approved runner as `command` and pass test targets through the structured `execution` object. If `jev_check_test` returns an `environmentReviewId`, show the exact runner and resource scope to the user and call `jev_environment_approve` only after explicit human approval. Environment Approval does not approve test code, policy findings, or Jev findings. A provider/model change requires code re-evaluation but does not, by itself, invalidate an otherwise matching Environment Approval.

For Profile v2, confirm that `codeReviewRoots` covers the relevant helpers, setup, and application code. The server inspects full current contents, not just manifests or diffs, using one deduplicated snapshot for all test files in the request. It applies Built-in/User/Project Policy and framework checks to raw contents and sends masked `relatedCode` (`file`, `content`) to Jev. Related findings may include a project-relative `file`. Original-byte changes, additions, and deletions invalidate matching code caches and Human Approval; do not infer unchanged identity from identical masked text. Raw contents are not retained in SQLite, logs, or MCP results. Masking is best-effort; independently check the scope for sensitive material.

The limits are 64 related files, 32 KiB per file, 64 KiB total original bytes, 4096 traversed entries including directories, and 256 KiB for the complete serialized Jev request. Missing/unreadable paths, parent or leaf symlinks, non-regular files, binary/non-UTF-8 contents, and exceeded limits return `RELATED_CODE_REVIEW_INCOMPLETE`, `decision=review`, `allowed=false`. Stop: there is no approvable `reviewId` or Execution Ticket. Do not call `jev_review_approve`, reuse an old approval/cache, truncate evidence, skip extensions, or remove relevant roots to evade this condition. Explain the reason, correct readability/scope/request size, and recheck. An already detected static `deny` stays `deny`. Related-review failure alone does not revoke a matching Environment Approval.

Only the supplied tests and explicit `codeReviewRoots` are in scope; the server does not automatically resolve imports, packages, or dynamic dependencies. An empty roots list specifies no additional review and must not be interpreted as proof of dependency safety. Large directories or lockfiles may exceed the limits. The `related-code-v1` evaluator invalidates older code caches/Human Reviews without changing SQLite schema 6. Use the updated server, re-evaluate, obtain new explicit Human Approval when requested, and obtain a new Execution Ticket; history and matching Environment Approval remain available. Never revert the evaluator or use an old review/ticket to avoid this check.

When an allow result contains an Execution Ticket, invoke only the approved safe runner. The runner must validate and consume the ticket after rechecking current environment, code, and execution fingerprints, effective database connections, config cache, fallback/additional connections, filesystem, network, and credentials. Source review does not prove actual runtime resources or the absence of fallback access. Never treat the ticket as permission to execute the raw `command` through a shell.

### Project policies

Respect all built-in, user, and project policies used by `jev-mcp-server`.

Project-specific rules may be defined in:

`.jev-policy.json`

Safety policies may make the default rules stricter. Do not attempt to override, weaken, or circumvent a stricter safety decision.

### Important

`jev-mcp-server` is an additional safety layer, not a replacement for engineering judgment.

Before high-impact operations, independently verify the target and expected effects even when Jev returns `allow`.
