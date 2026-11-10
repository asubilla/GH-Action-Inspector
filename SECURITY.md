# Security policy

## Supported versions

Security fixes are made on the default branch and, when a release exists, in the latest published minor version. Older versions may not receive fixes.

## Reporting a vulnerability

Please **do not open a public issue** for a suspected vulnerability.

Use the repository's **Security** tab and choose **Report a vulnerability** to open a private GitHub security advisory. If private advisories are unavailable, contact the maintainers through the repository's listed contact method and ask for a private channel.

Include:

- a description of the issue and its impact;
- affected version or commit;
- reproduction steps using **synthetic** data;
- any relevant configuration, with secrets removed.

Do **not** include real GitHub tokens, private repository names, customer data, or full log files. If a log line is essential, redact it and describe its shape.

Maintainers will acknowledge the report as availability permits and coordinate disclosure. There is no guaranteed response time or bug bounty.

## Security model in brief

- The server is read-only. It implements only GET requests to documented GitHub read endpoints. It cannot trigger, cancel, rerun, approve, dispatch, create issues/PRs, commit, push, or modify settings.
- The token is read only from `GITHUB_TOKEN` and is never accepted as a tool argument, logged, returned, or placed in a URL.
- Authorization is attached only to the configured GitHub API origin. GitHub job-log redirects to signed object storage are followed without the header.
- Logs and workflow files are untrusted data. The server never executes commands found in them and never follows instructions embedded in them.
- Log excerpts are bounded and passed through best-effort redaction. Redaction is **not a guarantee**.
- No logs, tokens, repository contents, or user data are persisted to disk at runtime.
- No external AI service, telemetry, or analytics is used.

See the README's **Security and threat model** section for controls and residual risks.

## Hardening recommendations

- Use a fine-grained token limited to the necessary repositories with **Actions: read** and **Metadata: read**; add **Contents: read** only if you need workflow-file content.
- Do not reuse a personal administrative token. Prefer a dedicated token or GitHub App installation token.
- Keep tokens in a client config with owner-only permissions or a user-level secret store, never in a repository, `.env` committed to git, or shell history.
- Review tool output before sending it to another model or person.
- Run the server from a trusted build (`npm ci && npm run build`) and review dependency updates.
- Rotate the token if you suspect it was exposed.

## Out of scope

- Vulnerabilities in GitHub itself or in MCP clients.
- Risks from a user pasting secrets into a repository or workflow log.
- Secrets that redaction failed to detect, unless the redaction rule is clearly missing for a well-known token format. Redaction is documented as best-effort.
- Misclassification of a failure by the deterministic rules, unless it indicates mishandled evidence or an unsupported claim.
