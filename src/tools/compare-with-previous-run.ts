import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildRunComparison } from "../analysis/compare.js";
import type { JobSummary } from "../github/types.js";
import { READ_ONLY_ANNOTATIONS, READ_ONLY_PREFIX } from "./annotations.js";
import type { ToolContext } from "./context.js";
import { runTool } from "./respond.js";
import { lookbackField, ownerField, repoField, runIdField } from "./schemas.js";

export const compareWithPreviousRunSchema = {
  owner: ownerField,
  repo: repoField,
  runId: runIdField,
  lookback: lookbackField,
};

export async function compareWithPreviousRun(
  ctx: ToolContext,
  input: { owner: string; repo: string; runId: number; lookback: number },
): Promise<unknown> {
  const current = await ctx.client.getWorkflowRun(input.owner, input.repo, input.runId);
  const candidates = await ctx.client.listWorkflowRuns({
    owner: input.owner,
    repo: input.repo,
    workflowId: current.workflowId,
    branch: current.branch ?? undefined,
    status: "success",
    limit: input.lookback,
    page: 1,
  });

  const previous =
    candidates.runs.find(
      (run) =>
        run.id !== current.id &&
        run.conclusion === "success" &&
        (current.branch === null || run.branch === current.branch) &&
        (current.createdAt === null
          ? run.id < current.id
          : run.createdAt === null || Date.parse(run.createdAt) < Date.parse(current.createdAt)),
    ) ?? null;

  let currentJobs: JobSummary[] = [];
  let previousJobs: JobSummary[] = [];
  let jobListsTruncated = false;

  if (previous !== null) {
    const [currentJobList, previousJobList] = await Promise.all([
      ctx.client.listJobsForRun(input.owner, input.repo, current.id),
      ctx.client.listJobsForRun(input.owner, input.repo, previous.id),
    ]);
    currentJobs = currentJobList.jobs;
    previousJobs = previousJobList.jobs;
    jobListsTruncated = currentJobList.truncated || previousJobList.truncated;
  }

  const comparison = buildRunComparison(
    current,
    previous,
    currentJobs,
    previousJobs,
    input.lookback,
  );

  const notes = [...comparison.notes];
  if (current.conclusion !== null && current.conclusion !== "failure") {
    notes.push(
      `The current run concluded ${current.conclusion}, not failure. The comparison is still reported for context.`,
    );
  }
  if (candidates.totalCount > candidates.runs.length) {
    notes.push(
      `Only the ${candidates.runs.length} most recent completed run(s) were searched out of ${candidates.totalCount} matching run(s). Increase lookback (max 50) for an older baseline.`,
    );
  }
  if (current.branch === null) {
    notes.push(
      "The current run has no branch, so the search was not branch-scoped; only successful runs of the same workflow were considered.",
    );
  }
  if (jobListsTruncated) {
    notes.push(
      "One or both job lists were truncated by the bounded job scan; some failed-step differences may be missing.",
    );
  }
  if (current.status !== "completed") {
    notes.push("The current run is not complete; its job list and failures may still change.");
  }

  return {
    ...comparison,
    search: {
      workflowId: current.workflowId,
      branch: current.branch,
      lookback: input.lookback,
      completedRunsScanned: candidates.runs.length,
      totalMatchingRuns: candidates.totalCount,
      foundSuccessfulBaseline: previous !== null,
    },
    notes,
  };
}

export function registerCompareWithPreviousRun(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "compare_with_previous_run",
    {
      title: "Compare with previous run",
      description:
        READ_ONLY_PREFIX +
        "Compare a run with the most recent successful run of the same workflow and branch, when one is available. Reports commit, event, attempt, duration, conclusion, and failed job/step differences. It does not fetch a code diff and does not claim that a commit change caused the failure.",
      inputSchema: compareWithPreviousRunSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      runTool(ctx, "compare_with_previous_run", () => compareWithPreviousRun(ctx, input)),
  );
}
