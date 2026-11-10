import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { durationSeconds, formatDuration } from "../util/text.js";
import { READ_ONLY_ANNOTATIONS, READ_ONLY_PREFIX } from "./annotations.js";
import type { ToolContext } from "./context.js";
import { runTool } from "./respond.js";
import { ownerField, repoField, runIdField } from "./schemas.js";

export const getWorkflowRunSchema = {
  owner: ownerField,
  repo: repoField,
  runId: runIdField,
};

export async function getWorkflowRun(
  ctx: ToolContext,
  input: { owner: string; repo: string; runId: number },
): Promise<unknown> {
  const run = await ctx.client.getWorkflowRun(input.owner, input.repo, input.runId);
  const duration = durationSeconds(run.startedAt ?? run.createdAt, run.updatedAt);
  const queue = durationSeconds(run.createdAt, run.startedAt);

  return {
    summary: `${run.name} ${run.runNumber === null ? `(run ${run.id})` : `#${run.runNumber}`} is ${run.status ?? "unknown"}${run.conclusion ? ` with conclusion ${run.conclusion}` : ""} on branch ${run.branch ?? "(unknown)"}.`,
    run,
    timing: {
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      durationSeconds: duration,
      duration: formatDuration(duration),
      queuedSeconds: queue,
    },
    commit: {
      sha: run.headSha,
      shortSha: run.headShaShort,
      branch: run.branch,
    },
    links: {
      run: run.url,
    },
    observations: [
      `Triggered by event "${run.event}"${run.actor ? ` by ${run.actor}` : ""}.`,
      `Attempt ${run.attempt} of workflow ID ${run.workflowId}.`,
      run.path ? `Workflow file: ${run.path}.` : "The API did not return a workflow file path.",
    ],
    notes: [
      run.status === "completed"
        ? "Run is complete."
        : "Run is still in progress; conclusions and job results may change.",
    ],
  };
}

export function registerGetWorkflowRun(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "get_workflow_run",
    {
      title: "Get workflow run",
      description:
        READ_ONLY_PREFIX +
        "Fetch one GitHub Actions run and return a concise summary with status, conclusion, branch, commit, timestamps, duration, actor, and links. The raw API response is not returned.",
      inputSchema: getWorkflowRunSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => runTool(ctx, "get_workflow_run", () => getWorkflowRun(ctx, input)),
  );
}
