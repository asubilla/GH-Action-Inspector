import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Every tool is strictly read-only. These hints are advertised to MCP clients so
 * they can avoid confirmation prompts that would be required for mutations.
 */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

export const READ_ONLY_PREFIX =
  "READ-ONLY. This tool never triggers, cancels, reruns, approves, or dispatches workflows, and never creates issues, commits, or repository changes. ";
