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

`jev_check_test` may return `decision=allow` from an unchanged Safety Fingerprint Cache entry or from a valid Human Approval for the same Safety Fingerprint. This is still subject to the same `allowed` and `needsHumanReview` checks. Cache hits and Human Review decisions are stored in the server's SQLite database for audit. A cache hit does not mean that Jev was called for that request. Changes to the command, test file, shared safety files, policies, Safety Profile, working directory/project, runtime/isolation evidence, evaluator version, Jev provider, or requested model invalidate reuse and cause code re-evaluation. Cache entries without provider identity are not reusable. Moving model aliases such as `jev-latest` are evaluated on every check and do not reuse an allow cache entry. API keys are not fingerprint inputs.

For Laravel, set `framework` to `laravel`. Existing Laravel evidence fields such as `runtimeDatabase`, `configCache`, `runtimeGuard`, and `persistentDatabaseAccess` remain supported. `RefreshDatabase`, `DatabaseMigrations`, `DatabaseTruncation`, `migrate:fresh`, `db:wipe`, persistent database targets, and test/runtime configuration mismatches must be treated as safety findings.

Never assume a test environment is isolated solely because a test configuration file, `.env.testing`, documentation, or environment name indicates that it is a test environment.

For a Safety Profile v2 project, pass only the approved runner as `command` and pass test targets through the structured `execution` object. If `jev_check_test` returns an `environmentReviewId`, show the exact runner and resource scope to the user and call `jev_environment_approve` only after explicit human approval. Environment Approval does not approve test code, policy findings, or Jev findings. A provider/model change requires code re-evaluation but does not, by itself, invalidate an otherwise matching Environment Approval.

When an allow result contains an Execution Ticket, invoke only the approved safe runner. The runner must validate and consume the ticket after rechecking current environment, code, and execution fingerprints, effective database connections, config cache, fallback connections, filesystem, and network. Never treat the ticket as permission to execute the raw `command` through a shell.

### Project policies

Respect all built-in, user, and project policies used by `jev-mcp-server`.

Project-specific rules may be defined in:

`.jev-policy.json`

Safety policies may make the default rules stricter. Do not attempt to override, weaken, or circumvent a stricter safety decision.

### Important

`jev-mcp-server` is an additional safety layer, not a replacement for engineering judgment.

Before high-impact operations, independently verify the target and expected effects even when Jev returns `allow`.
