import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isFailedJob } from "../github/mappers.js";
import { READ_ONLY_ANNOTATIONS, READ_ONLY_PREFIX } from "./annotations.js";
import type { ToolContext } from "./context.js";
import { runTool } from "./respond.js";
import { ownerField, repoField, runIdField } from "./schemas.js";

export const listFailedJobsSchema = {
  owner: ownerField,
  repo: repoField,
  runId: runIdField,
};

export async function listFailedJobs(
  ctx: ToolContext,
  input: { owner: string; repo: string; runId: number },
): Promise<unknown> {
  const run = await ctx.client.getWorkflowRun(input.owner, input.repo, input.runId);
  const jobList = await ctx.client.listJobsForRun(input.owner, input.repo, input.runId);
  const failedJobs = jobList.jobs.filter(isFailedJob);

  const notes: string[] = [];
  if (failedJobs.length === 0) {
    notes.push(
      "No failed, cancelled, or timed-out jobs were returned. The run may still be in progress, or its jobs may be beyond the bounded scan.",
    );
  }
  if (jobList.truncated) {
    notes.push(
      `Only ${jobList.jobs.length} of ${jobList.totalCount} job(s) were scanned to bound the response; additional jobs may exist.`,
    );
  }

  return {
    summary: `Found ${failedJobs.length} failed, cancelled, or timed-out job(s) out of ${jobList.jobs.length} scanned job(s).`,
    run: {
      id: run.id,
      name: run.name,
      runNumber: run.runNumber,
      status: run.status,
      conclusion: run.conclusion,
      branch: run.branch,
      headSha: run.headSha,
      url: run.url,
    },
    totalJobs: jobList.totalCount,
    jobsScanned: jobList.jobs.length,
    truncated: jobList.truncated,
    failedJobs: failedJobs.map((job) => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion,
      status: job.status,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      durationSeconds: job.durationSeconds,
      url: job.url,
      stepsCount: job.stepsCount,
      failedSteps: job.failedSteps,
    })),
    notes,
  };
}

export function registerListFailedJobs(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_failed_jobs",
    {
      title: "List failed jobs",
      description:
        READ_ONLY_PREFIX +
        "List jobs in a run that failed, were cancelled, or timed out. Includes failed step names, conclusions, and timestamps when GitHub provides them, plus job URLs for full logs.",
      inputSchema: listFailedJobsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => runTool(ctx, "list_failed_jobs", () => listFailedJobs(ctx, input)),
  );
}
