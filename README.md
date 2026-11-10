# GH Action Inspector

**GH Action Inspector** is a small, **read-only** Model Context Protocol (MCP) server that helps an AI assistant investigate failed GitHub Actions runs. It can find recent runs, inspect jobs and failed steps, pull bounded excerpts from job logs, classify likely failure areas with transparent rules, compare a failed run with the last successful run on the same workflow and branch, and explain what permissions a token needs.

It is deliberately not an automation tool. It cannot trigger, cancel, rerun, approve, or dispatch workflows; create issues, comments, or pull requests; commit or push code; or change repository settings. There is no code path that sends a non-GET request to GitHub.

> **Logs can contain secrets and customer data.** Redaction is best-effort, not a guarantee. Review any tool output before sharing it.

## The problem

A failed Actions run is spread across a run page, a job list, several step logs, and sometimes a previous successful run. An assistant can help, but only if it has a narrow, safe way to fetch the relevant parts without dumping megabytes of untrusted log text into a model context or leaking credentials.

This server provides that narrow interface:

- explicit, validated inputs and bounded outputs;
- stable JSON that is easy for an assistant to reason about;
- observed facts separated from heuristic inference;
- no external AI calls and no persistence of logs or tokens.

## Read-only guarantee

| Cannot do | Enforced by |
| --- | --- |
| Trigger, rerun, cancel, approve, or dispatch workflows | Only documented read endpoints exist; no write endpoints are implemented. |
| Create issues, comments, or pull requests | No such client methods or API calls. |
| Commit, push, merge, or modify refs | No `git` data mutation, merge, or contents write calls. |
| Change actions secrets, variables, or branch protection | Not implemented. |
| Accept a token as a tool argument | No tool schema defines a token field; the token is read only from the process environment. |
| Send logs to an external AI service | The server makes no external model calls; only GitHub API requests and GitHub's signed log download redirects. |
| Persist logs or tokens | No runtime filesystem writes for triage data; diagnostics go to stderr without tokens or log bodies. |

The test suite includes a repository scan that fails if a write-capable HTTP method or GitHub write endpoint is added to the GitHub layer.

## Features

- **Eight read-only MCP tools** for workflow runs, failed jobs, log excerpts, failure analysis, run comparison, workflow metadata, and access checks, all annotated `readOnlyHint: true`.
- **Run discovery and inspection**: filter recent workflow runs by branch, status, event, and date; inspect conclusions, commits, timings, actors, and links.
- **Failed job and step detail**: list failed, cancelled, timed-out, or action-required jobs with the failed step names and job URLs.
- **Bounded, redacted log excerpts**: request only the lines around failure signals, with context, line numbers, and hard output caps.
- **Deterministic failure analysis**: transparent rule ids, weights, scores, confidence, alternatives, and evidence, separating observed facts from inference.
- **Previous-run comparison**: compare a failed run with the latest successful run of the same workflow and branch without claiming causation.
- **Workflow file metadata**: inspect only `.github/workflows/*.yml` or `*.yaml`, with optional redacted content and a strict size limit.
- **Access and rate-limit diagnostics**: distinguish authentication, permission, repository visibility, and rate-limit problems with actionable guidance.
- **Guided setup for 11 MCP clients**: an interactive `setup` wizard detects installed clients and configures only the clients you select; explicit `--client` flags remain available for automation.
- **Human and JSON detection reports**: `setup --detect` shows detection evidence without writing anything, and `--json` provides a stable machine-readable form for scripts and CI.
- **`doctor` diagnostics**: reports runtime, configuration, token state, client detection, authenticated user, and rate limits; optionally verifies repository access.
- **Read-only by construction**: no write-capable GitHub methods exist, and a source-scanning test fails if write endpoints are added.
- **Privacy-minded by default**: no external AI calls, no runtime persistence of logs, tokens read only from `GITHUB_TOKEN`, and best-effort redaction before output.
- **Fail-safe startup and testing**: the server starts without a token and returns setup guidance; the test suite and synthetic demo need no token or network.
- **Strict TypeScript** with Zod validation, the official MCP TypeScript SDK over stdio, and a minimal typed GitHub client.

## Requirements

- Node.js **22.12+** (LTS; CI also tests Node 24).
- npm 10+.
- A GitHub token for real use. Tests and the demo need no token and no network.

## Quick start

```bash
git clone https://github.com/asubilla/GH-Action-Inspector.git
cd GH-Action-Inspector
npm ci
npm run build

# Check configuration and (optionally) repository access
export GITHUB_TOKEN="<your read-only token>"   # never commit this
node dist/cli.js doctor --repo your-org/your-repo

# Interactive wizard: detects installed clients, configures only what you select
node dist/cli.js setup

# Report only: show detected clients and evidence, write nothing
node dist/cli.js setup --detect

# Or target one client directly
node dist/cli.js setup --client cursor --write   # add --local to point at dist/cli.js
```

When running from a local build, add `--local` to `setup`, or use `node /absolute/path/to/dist/cli.js` as the command. When published to npm, the `npx -y gh-action-inspector@latest` form is convenient.

When setup writes a configuration, it writes only a placeholder token. Replace `<YOUR_GITHUB_TOKEN>` locally and keep the file out of version control.

## MCP launch

The default command is the stdio server:

```bash
node dist/cli.js
# or, after npm installation:
npx -y gh-action-inspector@latest
```

No network listener is started. The server reads MCP messages from stdin and writes protocol messages to stdout; diagnostics go to stderr.

### Local development mode

```bash
npm run dev          # tsx watch src/cli.ts (stdio server)
npm run demo         # synthetic, mocked walkthrough; no network or token
npm run inspector    # MCP Inspector against the built server
```

`npm run inspector` requires a build first.

## Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `GITHUB_TOKEN` | For real GitHub data | — | Read from the environment only. Never accepted in tool arguments or returned. |
| `GITHUB_API_BASE_URL` | No | `https://api.github.com` | Must be HTTPS. Plain HTTP is accepted only for loopback (`localhost`, `127.0.0.1`, `::1`) development. Credentials, query strings, and fragments are rejected. GitHub Enterprise example: `https://ghe.example.com/api/v3`. |
| `GH_ACTION_INSPECTOR_LOG_CHARS` | No | `6000` | Default excerpt budget. Clamped to 500–20,000. The hard cap cannot be raised. |
| `GH_ACTION_INSPECTOR_TIMEOUT_MS` | No | `15000` | Per-request timeout, clamped to 1,000–60,000 ms. |
| `GH_ACTION_INSPECTOR_DEBUG` | No | `false` | `true`/`1`/`yes`/`on` enables stderr diagnostics with method paths, status, and timings only. Tokens and response bodies are never logged. |
| `GH_ACTION_INSPECTOR_EXTRA_REDACTION_PATTERNS` | No | empty | Additive only. Comma/newline-separated regular expressions, max 20 patterns, 200 characters each. Built-in redaction cannot be disabled. Treat these as trusted local configuration and avoid expressions with catastrophic backtracking. |

The server does **not** load `.env` automatically. For local development:

```bash
cp .env.example .env
# edit .env, then:
node --env-file=.env dist/cli.js
```

`.env` and `.env.*` are gitignored (except `.env.example`).

### Safety-relevant limits

- **Runs per request:** 1–100 (GitHub page cap), page 1–10.
- **Jobs scanned:** at most 300 (three pages of 100) per run.
- **Log text returned:** default 6,000 characters, hard cap 20,000, further limited by `maxChars`.
- **Log download buffer:** 8 MiB decompressed text, keeping the head and tail when larger. The tool reports when the middle was omitted.
- **Lines analyzed:** up to 30,000 per log, preserving original line numbers.
- **Workflow file content:** at most 128 KiB decoded and 20,000 characters returned; only `.github/workflows/*.yml` or `*.yaml`.
- **Serialized tool response:** 100,000 characters, then a safe `RESPONSE_TOO_LARGE` error.
- **Retries:** one short retry for network errors or 5xx responses. Rate limits and timeouts are never retried in a loop.

## GitHub permissions

Use a **fine-grained personal access token** limited to the repositories you need:

| Permission | Level | Needed for |
| --- | --- | --- |
| Metadata | Read | Repository lookup and basic access checks (required by fine-grained tokens). |
| Actions | Read | Runs, jobs, and job logs. |
| Contents | Read | Optional; only `get_workflow_file_metadata` with `includeContent`. |

No write permission is needed or recommended. For classic tokens, private repository access generally requires `repo` (which includes Actions read); public repositories can use `public_repo`. Fine-grained tokens may also need organization approval before they can access organization repositories.

Private repositories commonly return **404** when the token cannot see them. `check_github_access` distinguishes this from a missing repository as far as the API allows and returns guidance.

> The `GITHUB_TOKEN` automatically provided inside a GitHub Actions workflow is a short-lived, workflow-scoped token. For local MCP use, create a dedicated read-only token or a GitHub App installation token and pass it as `GITHUB_TOKEN` to the server process.

## Connecting your MCP client

### Interactive setup wizard

Run `gh-action-inspector setup` in a terminal (or `setup --interactive` to force it) for a guided setup. The wizard:

- scans known application locations, `PATH` commands, configuration directories, and editor extension folders;
- lists every supported client, marking the ones it detected and showing the evidence;
- asks which numbered clients to configure, defaulting to the detected set;
- offers to merge writable JSON configs or print snippets for review;
- writes only the selected clients — it never modifies an unselected client configuration.

Detection is advisory and only checks for files and directories; it never reads configuration contents or `GITHUB_TOKEN`. Every client remains selectable even when automatic detection misses it. The wizard writes a token placeholder, creates a backup before merging, and preserves other servers in the same file.

### Detection report

Run `gh-action-inspector setup --detect` to print every supported client's detection status and evidence, then exit. This is useful when the wizard misses a client or when you want to confirm what is installed before changing anything.

Add `--json` for scripts and CI:

```bash
gh-action-inspector setup --detect --json
```

The JSON contains a detected/total count and one entry per client with its id, name, detection boolean, evidence, config path, and whether that config already exists.

The report is read-only: it does not prompt, read configuration contents, read `GITHUB_TOKEN`, use the network, or write files. It cannot be combined with `--client`, `--write`, or `--interactive`.

`gh-action-inspector doctor` also includes the same client detection data under `clients`, even when `GITHUB_TOKEN` is not configured.

### Explicit client selection

For scripts and reproducible instructions, use the explicit commands below. For a local build, prefix them with `node dist/cli.js` (or use the installed `gh-action-inspector` binary). `--client all` prints every snippet, and `--write` merges into the JSON clients marked writable (one `gh-action-inspector` entry, other servers preserved, backup created, `0600` permissions). Ready-to-copy files with placeholders live in [`examples/mcp/`](examples/mcp/).

| Client | Command | `--write` |
| --- | --- | --- |
| Claude Desktop | `setup --client claude-desktop` | Yes |
| Claude Code | `setup --client claude-code` | Prints `claude mcp add` command |
| Cursor | `setup --client cursor` | Yes |
| VS Code (Copilot agent mode) | `setup --client vscode` | Yes (project `.vscode/mcp.json`) |
| Windsurf | `setup --client windsurf` | Yes |
| Zed | `setup --client zed` | Yes |
| Cline | `setup --client cline` | UI-managed; prints JSON |
| JetBrains IDEs | `setup --client jetbrains` | UI-managed; prints JSON |
| Continue | `setup --client continue` | Prints YAML |
| Codex CLI | `setup --client codex` | Prints TOML |
| Generic stdio client | `setup --client generic` | Prints JSON |

### Claude Desktop / Cursor / Cline

```json
{
  "mcpServers": {
    "gh-action-inspector": {
      "command": "npx",
      "args": ["-y", "gh-action-inspector@latest"],
      "env": {
        "GITHUB_TOKEN": "<YOUR_GITHUB_TOKEN>"
      }
    }
  }
}
```

For a local build, use `"command": "node"` and `"args": ["/absolute/path/to/dist/cli.js"]`.

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json` uses a `servers` object:

```json
{
  "servers": {
    "gh-action-inspector": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "gh-action-inspector@latest"],
      "env": { "GITHUB_TOKEN": "<YOUR_GITHUB_TOKEN>" }
    }
  }
}
```

Add `.vscode/mcp.json` to `.gitignore` if it will contain a token, then run **MCP: List Servers** from the Command Palette.

### Zed

```json
{
  "context_servers": {
    "gh-action-inspector": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "gh-action-inspector@latest"],
      "env": { "GITHUB_TOKEN": "<YOUR_GITHUB_TOKEN>" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add --transport stdio gh-action-inspector \
  --env GITHUB_TOKEN=<YOUR_GITHUB_TOKEN> \
  -- npx -y gh-action-inspector@latest
```

### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.gh-action-inspector]
command = "npx"
args = ["-y", "gh-action-inspector@latest"]
env = { GITHUB_TOKEN = "<YOUR_GITHUB_TOKEN>" }
```

### Continue (`~/.continue/config.yaml`)

```yaml
mcpServers:
  - name: gh-action-inspector
    command: npx
    args:
      - -y
      - gh-action-inspector@latest
    env:
      GITHUB_TOKEN: "<YOUR_GITHUB_TOKEN>"
```

### Token placement and GUI clients

GUI clients usually launch the server without your shell environment. That is why their configuration needs an `env` block. Prefer a per-user config file outside the repository. Never commit a config file containing a token. If an IDE supports secret/input references (for example VS Code `${input:...}`), use them instead of a literal token.

## Tools

Successful calls return a single JSON text block. Tool failures return `isError: true` with a safe `{ error: { code, message, hint } }` object; no stack traces, headers, upstream bodies, or tokens. Input-schema validation failures are rejected by the MCP SDK before the handler runs and are reported as a plain validation error result.

| Tool | Inputs | Behavior |
| --- | --- | --- |
| `list_workflow_runs` | `owner`, `repo`, optional `branch`, `status`, `event`, `createdAfter`, `createdBefore`, `limit` (1–100, default 20), `page` (1–10, default 1) | Newest-first run summaries: ID, workflow, branch, SHA, status, conclusion, timestamps, URL, actor. |
| `get_workflow_run` | `owner`, `repo`, `runId` | One run with timing, commit, links, and concise observations. |
| `list_failed_jobs` | `owner`, `repo`, `runId` | Failed, cancelled, timed-out, or action-required jobs, with failed step names, conclusions, timestamps, and job URLs. Scans at most 300 jobs. |
| `get_job_log_excerpt` | `owner`, `repo`, `jobId`, optional `maxChars`, `contextLines` (0–8), `maxExcerpts` (1–10) | Redacted excerpts around failure signals with line numbers. Never returns a full log. |
| `analyze_workflow_failure` | `owner`, `repo`, `runId`, optional `maxJobs` (1–10, default 5), `maxCharsPerJob` (500–8,000), `includeLogs` (default true) | Triage report combining metadata, failed steps, excerpts, classification, observations, inference, uncertainties, and next steps. |
| `compare_with_previous_run` | `owner`, `repo`, `runId`, optional `lookback` (1–50, default 20) | Differences from the most recent successful run of the same workflow and branch: commit, duration, event, attempt, failed jobs/steps. No code diff and no causation claim. |
| `get_workflow_file_metadata` | `owner`, `repo`, exactly one of `workflowPath`, `runId`, `workflowId`; optional `ref`, `includeContent` (default false), `maxChars` | Workflow file metadata; redacted, size-limited content only when explicitly requested. Rejects unrelated paths. |
| `check_github_access` | `owner`, `repo`, optional `checkContents` (default false) | Verifies repository and Actions read access, optional Contents read, rate-limit state, token kind/scopes when exposed, and permission guidance. Never returns the token. |

### Failure categories

The classifier is deterministic and rule-based. It scores signals from job names, failed step names, and bounded log excerpt lines. Signals have stable ids and weights, and the report lists matched rules, sources, scores, alternatives, and confidence.

- `test_failure`
- `lint_failure`
- `type_check_failure`
- `dependency_installation`
- `build_failure`
- `timeout`
- `permissions`
- `cancelled`
- `unknown`

Confidence is `low`, `medium`, or `high`. High confidence requires a structured timeout/cancellation conclusion or a decisive lead from explicit log evidence. A category is **not** a root cause; the report always separates:

- **`observed`**: what the API and logs factually say.
- **`inference`**: the likely category and confidence.
- **`uncertainties`**: missing logs, ambiguous signals, truncation, or bounded scans.
- **`nextSteps`**: practical debugging actions.

## Example: investigating a failed run

A developer asks an assistant: *"CI failed on my PR; can you triage it?"*

1. The assistant calls:

   ```json
   {
     "tool": "list_workflow_runs",
     "arguments": {
       "owner": "acme",
       "repo": "widgets",
       "branch": "feature/checkout",
       "status": "failure",
       "limit": 5
     }
   }
   ```

   It finds run `1234567890` for workflow `CI`.

2. It calls `analyze_workflow_failure` with that run ID. The response contains job metadata, redacted excerpts, and a report like:

   ```json
   {
     "summary": "CI #184 failed with 1 affected job(s); likely test failure (high confidence).",
     "run": { "id": 1234567890, "conclusion": "failure", "headSha": "…" },
     "failure": {
       "category": "test_failure",
       "confidence": "high",
       "basis": "log-and-metadata",
       "score": 16,
       "matchedRules": [
         { "id": "test-assertion", "score": 6, "sources": ["log"] }
       ],
       "alternatives": []
     },
     "evidence": [
       {
         "job": "test",
         "lineNumber": 214,
         "marker": "Test assertion failure",
         "text": "AssertionError: expected 201 to be 200"
       }
     ],
     "observed": [
       "Job \"test\" concluded failure; failed step(s): Run unit tests.",
       "Examined 1 excerpt(s) from job \"test\" (812 total log lines; 812 scanned)."
     ],
     "inference": [
       "The available evidence is most consistent with test failure (high confidence, score 16).",
       "This label is an inference from matched rules and bounded excerpts, not a verified root cause."
     ],
     "nextSteps": [
       "Identify the failing test and command from the log excerpt, then run that command locally on the same commit.",
       "Check whether the test is flaky by comparing with previous runs of the same workflow and branch."
     ]
   }
   ```

3. It calls `compare_with_previous_run`. If the previous successful run used the same commit, the response says the failure may be flaky or environment-dependent. If the commits differ, it says the difference is *one possible* explanation and that the data does not establish causation.

4. The assistant summarizes the evidence and suggests running the failing test locally, while linking the run and job URLs so the developer can open the full logs.

This example is illustrative, not a benchmark or a claim of accuracy.

## Architecture

```text
src/
├── cli.ts                     stdio entry, setup/doctor commands, help
├── server.ts                  MCP server creation and tool registration
├── config.ts                  env parsing, HTTPS/loopback validation, hard caps
├── errors.ts                  safe error codes, hints, no-stack responses
├── logger.ts                  stderr-only sanitized diagnostics
├── github/
│   ├── client.ts              typed GET-only client, timeouts, redirects, rate limits
│   ├── read.ts                memory-bounded response reader (head/tail)
│   ├── schemas.ts             Zod schemas for the GitHub fields used
│   ├── mappers.ts             raw API → domain summaries
│   ├── types.ts               GitHubReader interface and domain types
│   └── workflow-path.ts       strict .github/workflows path validation
├── log/
│   ├── ansi.ts                ANSI/control-character and timestamp normalization
│   ├── redact.ts              best-effort secret redaction (additive-only)
│   └── excerpts.ts            marker windows, context, line numbers, hard output cap
├── analysis/
│   ├── signals.ts             transparent rule table with weights
│   ├── categories.ts          categories, labels, next steps
│   ├── classify.ts            scoring, confidence, evidence, uncertainties
│   ├── triage.ts              observed-vs-inference report builder
│   └── compare.ts             run comparison without causation claims
├── tools/                     one module per MCP tool plus shared schemas/response helpers
├── setup/                     client catalog, detection, wizard, snippets, safe JSON merger
└── util/text.ts               truncation, duration, and short-SHA helpers
```

**Data flow:** MCP tool → Zod-validated input → `GitHubReader` → domain summary → redaction/excerpting → analysis → bounded JSON response.

**Trust boundaries:** tool arguments are untrusted; GitHub responses and log text are untrusted data; log text is never executed or interpreted as instructions; only GitHub HTTPS origins receive the token.

## Security and threat model

### Assets

- The GitHub token.
- Repository metadata, workflow definitions, logs, and any secrets or personal data they contain.
- The integrity of the user's GitHub repository and workflows.

### Threats and mitigations

| Threat | Mitigation |
| --- | --- |
| A tool or prompt causes a workflow mutation | No write methods or endpoints exist. The test suite scans the GitHub layer for write verbs and write endpoints. |
| Token appears in output, arguments, URLs, logs, errors, or traces | Token comes only from `GITHUB_TOKEN`; schemas have no token field; errors use fixed messages; stderr logging excludes bodies and headers; tests assert the token never appears. |
| Token leaks to a third-party log host | Redirects are followed manually; `Authorization` is attached only to the configured API origin and stripped cross-origin. Non-HTTPS and credential-bearing redirects are refused. |
| Secret in a log is returned to the model | Best-effort redaction covers GitHub token formats, private-key blocks, authorization/bearer headers, AWS/Slack/Stripe/npm/Google/GitLab/OpenAI/Anthropic token shapes, JWTs, URL userinfo, sensitive query parameters, JSON secret properties, and `TOKEN`/`SECRET`/`PASSWORD`/`API_KEY`-style assignments. GitHub `***` masks are flagged. |
| Huge or hostile responses exhaust memory/context | 8 MiB log buffer, 30k analyzed lines, 20k excerpt hard cap, 4 MiB JSON cap, 100k serialized-response cap, timeouts, no unbounded log return. |
| Prompt injection from log or workflow content | Content is only classified and quoted as data. The server never executes commands found in logs/workflow files and never follows instructions from them. Server instructions tell the assistant the same. |
| Unrelated repository files are exposed | Only `.github/workflows/*.yml|*.yaml` is readable, only via the optional content flag, with strict path validation on both the tool and client sides. |
| Timing or commit differences are presented as proven causes | Comparison output has `causation: "not_determined"` and explicit wording; classification always separates observation from inference. |
| Token is persisted by the server | No runtime persistence of triage data. The optional setup command writes a **placeholder** token to a user-requested client config with `0600` permissions; it never reads `GITHUB_TOKEN`. |
| Unauthenticated network listener | None is started. Only stdio transport is used. |

### Redaction is not a guarantee

Redaction is pattern-based. It can miss secrets in unusual formats, prose, encoded blobs, artifacts, or values GitHub did not mask. It can also over-redact harmless text that looks like a credential. Treat every excerpt as potentially sensitive, avoid sharing logs from untrusted repositories, and review tool output before pasting it elsewhere.

### What is sent where

- **To GitHub:** authenticated HTTPS GET requests for repository, run, job, log, workflow, contents, user, and rate-limit data. Job logs may redirect to GitHub-operated signed object storage; no authorization header is sent there.
- **To an MCP client:** bounded JSON summaries and redacted excerpts.
- **To external AI services:** nothing. This server does not call a model provider. Your MCP client may send tool results to its own model; that is outside this server's control.

### Reporting a vulnerability

See [SECURITY.md](SECURITY.md). Do not include real tokens or private log contents in a report.

## Limitations

- **Logs expire.** GitHub typically retains Actions logs for 90 days; older or deleted logs return `LOG_UNAVAILABLE`.
- **Classification is heuristic.** The rules are intentionally simple and explainable, not a model. Ambiguous mixed failures produce alternatives, not certainty.
- **Job scanning is bounded.** At most 300 jobs per run are scanned; hidden jobs beyond that are reported as truncated.
- **No artifacts, caches, annotations, check runs, or code diffs.** The server focuses on runs, jobs, and logs. `compare_with_previous_run` does not fetch commits or a diff.
- **No repository-wide search.** You provide owner, repository, and run/job IDs; the server does not crawl organizations.
- **Log excerpts can miss the cause.** Very large logs are buffered head/tail, and excerpts are selected by markers. Request a larger `maxChars` or open the run URL for the full log.
- **GitHub API rate limits apply.** Unauthenticated use is not supported; authenticated limits vary by token type.
- **GitHub Enterprise support depends on API parity.** The base URL is configurable, but older GHES versions may not support every endpoint or field.
- **`check_github_access` cannot prove log access without downloading a log.** It proves repository, Actions list, and optional Contents access. Log expiry and job-level restrictions can still cause a later `LOG_UNAVAILABLE`.
- **Not affiliated with GitHub.** GitHub and GitHub Actions are trademarks of GitHub, Inc.

## Troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| `AUTH_MISSING` | `GITHUB_TOKEN` is not set in the process that launched the server. | Add it to the MCP client's `env` block or the environment used to launch the server, then restart the client. |
| `AUTH_INVALID` | Expired, revoked, or malformed token. | Create a new read-only token. Tokens are never accepted in tool arguments. |
| `FORBIDDEN` or 404 for a private repo | Token lacks repository access, Actions read, or organization approval. | Run `check_github_access`, grant Actions: read and Metadata: read, and approve the fine-grained token for the organization if prompted. |
| `RATE_LIMITED` | Primary or secondary GitHub limit. | Wait for the reset, reduce `limit`/`lookback`, and avoid repeated large analyses. The server does not retry rate limits. |
| `TIMEOUT` / `NETWORK` | No network, proxy/firewall, wrong GHES base URL, or slow log. | Verify connectivity and `GITHUB_API_BASE_URL` (HTTPS), then retry with fewer jobs or a smaller excerpt. |
| `LOG_UNAVAILABLE` | Expired log, deleted run, missing Actions read, or HTML login response. | Confirm Actions: read and check the run's age; open the run URL for what GitHub still shows. |
| `RESPONSE_TOO_LARGE` | Requested range or content exceeded a safety cap. | Narrow the filters, lower `maxChars`, or request fewer jobs. |
| `INVALID_INPUT` | Bad owner/repo/branch/path, a date range in reverse, or multiple workflow-file sources. | Check the tool schema and error hint. |
| `CONFIG_INVALID` | Non-HTTPS remote API URL, embedded credentials, malformed token, or invalid extra redaction regex. | Fix the environment variable and restart. |
| Server does not appear in the client | Wrong config path, client not restarted, or `npx` cannot resolve the package. | Run `gh-action-inspector setup` to detect clients and configure only the right one, use an absolute `node dist/cli.js` command for a local build, and restart the client. |
| Tools work but logs are empty | The job produced no output, did not start, or the log has expired. | Check the job page and the `LOG_UNAVAILABLE` guidance. |

Enable `GH_ACTION_INSPECTOR_DEBUG=true` for stderr diagnostics (request path, status, duration, tool timing). Tokens, headers, and log bodies are not logged.

## Development

```bash
npm ci
npm run build         # tsc → dist/
npm run typecheck
npm run lint
npm run format:check
npm run test          # Vitest, fully mocked; no token or network
npm run test:coverage
npm run demo          # synthetic in-memory walkthrough
npm run verify        # format, lint, typecheck, test, build
```

Test coverage includes:

- valid and invalid inputs for every tool;
- pagination and result limits;
- classification, confidence, evidence, and recommendations;
- secret redaction, including representative synthetic tokens and private-key text;
- truncation, empty logs, missing logs, and large-log sampling;
- 401/403/404/429/5xx/timeout/network failures and response-size limits;
- redirect authorization stripping;
- MCP startup, tool registration, and read-only annotations;
- a source scan proving no write-capable GitHub operation exists;
- client detection, human and JSON detection reports, interactive wizard selection, and safe JSON merging.

Tests use `FakeGitHubReader` and an injected `fetch` implementation. They must never require a real token or network access.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Security reports go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Do not overwrite an existing license if you fork this project; keep the original notices.
