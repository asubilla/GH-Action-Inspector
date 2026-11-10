import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { registerAnalyzeWorkflowFailure } from "./analyze-workflow-failure.js";
import { registerCheckGitHubAccess } from "./check-github-access.js";
import { registerCompareWithPreviousRun } from "./compare-with-previous-run.js";
import { registerGetJobLogExcerpt } from "./get-job-log-excerpt.js";
import { registerGetWorkflowFileMetadata } from "./get-workflow-file-metadata.js";
import { registerGetWorkflowRun } from "./get-workflow-run.js";
import { registerListFailedJobs } from "./list-failed-jobs.js";
import { registerListWorkflowRuns } from "./list-workflow-runs.js";

export const TOOL_NAMES = [
  "list_workflow_runs",
  "get_workflow_run",
  "list_failed_jobs",
  "get_job_log_excerpt",
  "analyze_workflow_failure",
  "compare_with_previous_run",
  "get_workflow_file_metadata",
  "check_github_access",
] as const;

/**
 * Tool registration is centralized so server startup tests can assert the full
 * surface, and so no write-capable tool can be added outside this list unnoticed.
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerListWorkflowRuns(server, ctx);
  registerGetWorkflowRun(server, ctx);
  registerListFailedJobs(server, ctx);
  registerGetJobLogExcerpt(server, ctx);
  registerAnalyzeWorkflowFailure(server, ctx);
  registerCompareWithPreviousRun(server, ctx);
  registerGetWorkflowFileMetadata(server, ctx);
  registerCheckGitHubAccess(server, ctx);
}
