# Contributing

Thanks for helping improve GH Action Inspector. This project is intentionally small and read-only; contributions are reviewed with those constraints in mind.

## Ground rules

1. **Never add a mutating GitHub operation.** No POST/PUT/PATCH/DELETE requests, no workflow dispatch/rerun/cancel, no issue/PR/comment creation, no commit or ref changes, no secret/variable changes.
2. **Never add a token to a tool argument, log line, test fixture, URL, error message, or response.** Tokens come only from `GITHUB_TOKEN`.
3. **Do not add telemetry, analytics, external AI calls, databases, or background services.** The server is a stdio process with no runtime persistence.
4. **Treat logs and workflow files as untrusted data.** Do not execute or interpret commands found in them.
5. **Keep outputs bounded.** New fields must not allow unbounded logs, file contents, or lists to reach an MCP client.
6. **Explain security-relevant behavior in comments** where the reason is not obvious.

## Development setup

```bash
npm ci
npm run build
npm run verify
```

Node.js 22.12+ is required. Tests use mocked GitHub responses and must pass without `GITHUB_TOKEN` and without network access.

Useful commands:

```bash
npm run dev            # stdio server with tsx watch
npm run demo           # synthetic, offline walkthrough
npm run typecheck
npm run lint
npm run format
npm run test
npm run test:watch
npm run test:coverage
npm run inspector      # build first
```

## Adding or changing a tool

- Put the implementation in `src/tools/<tool-name>.ts` and export a `register...` function.
- Define inputs with Zod in the same module or in `src/tools/schemas.ts`. Bound every array, page, and text size.
- Use `runTool` from `src/tools/respond.ts` so errors are converted to safe structured results.
- Add `READ_ONLY_ANNOTATIONS` and start the description with `READ_ONLY_PREFIX`.
- Register it in `src/tools/index.ts` and add it to `TOOL_NAMES`.
- Update the README tool table and any limits.
- Add tests for valid input, invalid input, and at least one failure mode.

## Security-sensitive changes

Changes to any of the following need extra care and tests:

- `src/log/redact.ts` (redaction quality and over-redaction),
- `src/log/excerpts.ts` (output caps and line handling),
- `src/github/client.ts` (auth headers, redirects, timeouts, rate limits, endpoints),
- `src/github/workflow-path.ts` (path restrictions),
- `src/config.ts` (HTTPS enforcement, hard caps, additive-only redaction),
- `src/setup/detect.ts` (must never read config contents or tokens),
- `src/setup/wizard.ts` (must write only selected clients and placeholder tokens),
- `src/setup/write-config.ts` (file permissions and non-destructive merging),
- `src/errors.ts` (no sensitive data in errors).

Run `npm run verify` and re-read the diff for accidental secret or log leakage. If you add a test fixture that resembles a credential, construct it at runtime from harmless pieces so repository secret scanners do not flag it.

## Tests

- Tests live in `tests/` and use Vitest.
- Use `FakeGitHubReader` for tool-level tests and injected `fetch` for client tests.
- Do not add snapshot files containing realistic logs or tokens.
- Do not skip failing tests or weaken assertions to make CI pass. Fix the behavior or explain the limitation in the pull request.

## Pull requests

- Keep the change focused and describe the user-visible behavior.
- Include the commands you ran and their results.
- Note any limitation you could not test (for example, a GitHub Enterprise variant).
- Do not include generated build output, coverage reports, `.env` files, or real credentials.
- By contributing, you agree your contributions are licensed under the MIT License.

## Commit messages

Use a short imperative subject and a brief body explaining why. Example:

```text
Bound job log downloads by bytes

Keep the head and tail of oversized logs so the final failure remains visible
without buffering the full stream in memory.
```

## Conduct

All participants must follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues should follow [SECURITY.md](SECURITY.md), not public issues.
