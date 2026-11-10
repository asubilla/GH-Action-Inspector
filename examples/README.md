# MCP configuration examples

These files contain placeholders only. Replace `<YOUR_GITHUB_TOKEN>` locally with a read-only fine-grained token, and never commit the filled-in file in a repository.

| File | Client | Destination |
| --- | --- | --- |
| `mcp/claude-desktop.json` | Claude Desktop | `claude_desktop_config.json` (merge into `mcpServers`) |
| `mcp/cursor.json` | Cursor | `~/.cursor/mcp.json` or project `.cursor/mcp.json` |
| `mcp/vscode.json` | VS Code (Copilot agent mode) | project `.vscode/mcp.json` |
| `mcp/zed.json` | Zed | Zed `settings.json` (merge into `context_servers`) |
| `mcp/codex.toml` | Codex CLI | `~/.codex/config.toml` |
| `mcp/continue.yaml` | Continue | `~/.continue/config.yaml` |
| `mcp/claude-code.sh` | Claude Code | run the script after replacing the placeholder |

For a guided setup, run the interactive wizard. It detects installed clients and changes only the clients you select:

```bash
node dist/cli.js setup
node dist/cli.js setup --interactive   # force the wizard, for example with piped answers
node dist/cli.js setup --detect        # report detected clients and evidence only
node dist/cli.js setup --detect --json # machine-readable detection report
```

For scripts, use the explicit generator, which knows the paths and can merge safely:

```bash
node dist/cli.js setup --client all
node dist/cli.js setup --client cursor --write
node dist/cli.js setup --client cursor --write --local   # local build instead of npx
```

For a local build, use:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/dist/cli.js"]
}
```

Required token permissions: **Actions: read** and **Metadata: read**. Add **Contents: read** only for `get_workflow_file_metadata`.
