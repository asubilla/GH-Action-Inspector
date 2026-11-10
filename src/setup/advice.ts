import { TOKEN_PLACEHOLDER } from "./clients.js";

export function securityNote(): string {
  return [
    "Security notes:",
    `- Replace ${TOKEN_PLACEHOLDER} locally with a fine-grained token limited to the repository.`,
    "- Required permissions: Actions: read and Metadata: read. Add Contents: read only for get_workflow_file_metadata.",
    "- Never commit a config file containing a token. Prefer a per-user config outside the repository.",
  ].join("\n");
}

export function nextStepNote(): string {
  return [
    "Next steps:",
    `1. Replace ${TOKEN_PLACEHOLDER} in each installed config with a read-only GitHub token.`,
    "2. Restart the selected clients so they load the new MCP server.",
    "3. Verify access with: gh-action-inspector doctor --repo <owner>/<repo>",
  ].join("\n");
}
