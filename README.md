# jev-mcp-server

A read-only MCP safety gate for AI coding agents that combines Cloudflare `typesafe/jev` with local static policies. It does not execute commands or tests; it only returns an `allow` / `review` / `deny` decision before execution.

## Setup

```sh
npm install
npm run build
```

Do not store credentials in the repository.

Create an `/jev-mcp-server/.env` file at the repository root and add your credentials:

```dotenv
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_TOKEN=your-api-token
```

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

Results include the backward-compatible `dangerous` field as well as `riskScore`, `categories`, category-specific `risks`, and `staticFindings`. `allowed=false` does not mean that execution is authorized.

The built-in policy is located at [`policies/default.json`](policies/default.json) and covers filesystem, Git, databases, containers, services, deployments, package management, and more. Operations that are clearly denied statically remain denied even if Jev returns a low-risk result.

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

When the final decision is `review`, the server creates a short-lived Human Review record and returns a `reviewId`. After an explicit human approval, call `jev_review_approve` with only that `reviewId`. The server loads the stored project, command, files, policy, runtime context, and Safety Fingerprint; caller-supplied fingerprints or commands are not accepted. A matching approval may allow the unchanged fingerprint on later checks, but any changed safety input is re-evaluated. `deny` always wins and cannot be overridden by Human Approval. `jev_review_reject` permanently rejects a pending review.

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

Generic test policy is always applied. A framework-specific policy is added only when `framework` is supplied; Laravel rules are provided as an example under [`policies/tests/laravel.json`](policies/tests/laravel.json). Built-in, User, Project, and Jev decisions use `allow < review < deny`.

### Safety Profile

Projects may define reusable test-safety evidence in `.jev/test-safety.json`. The profile is framework-neutral and declares safety-related files plus expected testing, isolation, database, and runtime conditions. A profile is not a permission or a guarantee: built-in, User, Project, and Jev `deny` decisions always win.

The listed files are fingerprinted with SHA-256. Verified state is kept outside the repository under the user Jev configuration directory (or `JEV_TEST_SAFETY_STATE_PATH`) and is never committed. `jev_check_test` remains read-only; explicit verification creates the state:

```sh
npm run verify-test-safety -- --cwd /path/to/project --input /path/to/jev-verification-input.json
```

After human verification, an unchanged profile, matching fingerprint, matching runtime context, and low-risk Jev result can return `allow` without repeating the same review. Profile changes, missing files, runner/framework changes, isolation changes, invalid profiles, policy findings, or new risks return `review` or `deny`. Do not put credentials or `.env` values in a profile or verified state.

The server only evaluates supplied evidence; it does not inspect a live process, connect to a database, or prove that runtime claims are truthful.

## Safety and privacy

- Does not execute commands or tests, or connect to databases.
- Does not trust command input or follow instructions contained in it.
- Masks common tokens, passwords, secrets, and API keys before sending input to Jev.
- Does not output the Cloudflare API Token to logs or MCP responses.
- Returns `review` fail-closed when the Jev API is unavailable, the response is invalid, or a policy cannot be loaded.
- This tool is not a complete shell parser or execution-environment audit. Review dynamic command generation, aliases, shell functions, and similar cases separately.

## Development

```sh
npm run typecheck
npm test
```

`npm test` runs the repository's unit tests. Commands evaluated in the tests are passed to a mocked Jev as input only; they are not executed.

## License

MIT License

## Disclaimer

This software is provided as a safety-assistance tool and does not guarantee that commands, code, or operations determined to be safe are actually safe.

The results produced by Jev and this MCP server may contain false positives, false negatives, errors, or incomplete assessments. Always review important or destructive operations yourself before execution, especially in production environments.

The authors and contributors are not responsible for any data loss, system failure, service interruption, security incident, financial loss, or other damages arising from the use or misuse of this software.

Use this software at your own risk.
