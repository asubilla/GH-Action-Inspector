#!/usr/bin/env bash
# Replace the placeholder first. Do not commit a real token.
set -euo pipefail

claude mcp add --transport stdio gh-action-inspector \
  --env GITHUB_TOKEN="<YOUR_GITHUB_TOKEN>" \
  -- npx -y gh-action-inspector@latest
