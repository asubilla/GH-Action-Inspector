import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriageError, toSafeError } from "../errors.js";
import { isFailedJob } from "../github/mappers.js";
import { extractLogExcerpts } from "../log/excerpts.js";
import {
  buildNonFailureNotice,
  buildTriageReport,
  type JobLogEvidence,
} from "../analysis/triage.js";
import { READ_ONLY_ANNOTATIONS, READ_ONLY_PREFIX } from "./annotations.js";
import type { ToolContext } from "./context.js";
import { runTool } from "./respond.js";
import { maxJobsField, ownerField, repoField, runIdField } from "./schemas.js";

const FAILURE_LIKE = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

const maxCharsPerJobField = z
  .number()
  .int()
  .min(500)
  .max(8_000)
  .default(4_000)
  .describe("Log excerpt budget per failed job (500-8000 characters). Defaults to 4000.");

const includeLogsField = z
  .boolean()
  .default(true)
  .describe("Set false to skip log downloads and classify from job/step metadata only.");

export const analyzeWorkflowFailureSchema = {
  owner: ownerField,
  repo: repoField,
  runId: runIdField,
  maxJobs: maxJobsField,
  maxCharsPerJob: maxCharsPerJobField,
  includeLogs: includeLogsField,
};

export async function analyzeWorkflowFailure(
  ctx: ToolContext,
  input: {
    owner: string;
    repo: string;
    runId: number;
    maxJobs: number;
    maxCharsPerJob: number;
    includeLogs: boolean;
  },
): Promise<unknown> {
  const run = await ctx.client.getWorkflowRun(input.owner, input.repo, input.runId);

  if (run.status !== "completed" || run.conclusion === null || !FAILURE_LIKE.has(run.conclusion)) {
    return buildNonFailureNotice(run);
  }

  const jobList = await ctx.client.listJobsForRun(input.owner, input.repo, input.runId);
  const allFailedJobs = jobList.jobs.filter(isFailedJob);
  const failedJobs = allFailedJobs.slice(0, input.maxJobs);

  if (failedJobs.length === 0) {
    throw new TriageError(
      "NOT_FOUND",
      "The run has a failure-like conclusion, but no failed jobs were found in the scanned job pages.",
      {
        hint: "The run may be very old, jobs may be missing, or the token may lack Actions: read. Open the run URL to inspect it directly.",
        status: 404,
      },
    );
  }

  const logEvidence: JobLogEvidence[] = [];
  for (const job of failedJobs) {
    if (!input.includeLogs) {
      logEvidence.push({ job, excerpts: null, error: null });
      continue;
    }
    try {
      const log = await ctx.client.getJobLog(input.owner, input.repo, job.id);
      const excerpts = extractLogExcerpts(
        log.text,
        {
          maxChars: input.maxCharsPerJob,
          contextLines: 3,
          maxExcerpts: 3,
          extraRedactionPatterns: ctx.config.extraRedactionPatterns,
        },
        { truncatedBySize: log.truncatedBySize, downloadedBytes: log.downloadedBytes },
      );
      logEvidence.push({ job, excerpts, error: null });
    } catch (error) {
      // Expired or inaccessible logs are expected; keep triaging the other jobs.
      if (error instanceof TriageError && error.code === "LOG_UNAVAILABLE") {
        logEvidence.push({ job, excerpts: null, error: toSafeError(error) });
        continue;
      }
      throw error;
    }
  }

  const report = buildTriageReport({
    run,
    failedJobs,
    logEvidence,
    jobsScanned: jobList.jobs.length,
    totalJobs: jobList.totalCount,
    totalFailedJobs: allFailedJobs.length,
    jobsTruncated: jobList.truncated,
    includeLogs: input.includeLogs,
    maxJobs: input.maxJobs,
    maxCharsPerJob: input.maxCharsPerJob,
  });

  return {
    ...report,
    omittedFailedJobs: Math.max(0, allFailedJobs.length - failedJobs.length),
    jobScan: {
      totalJobs: jobList.totalCount,
      jobsScanned: jobList.jobs.length,
      truncated: jobList.truncated,
    },
  };
}

export function registerAnalyzeWorkflowFailure(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "analyze_workflow_failure",
    {
      title: "Analyze workflow failure",
      description:
        READ_ONLY_PREFIX +
        "Combine run metadata, failed jobs, failed steps, and bounded redacted log excerpts into a triage report. Categorizes likely failures with transparent deterministic rules (test, lint, type-check, dependency installation, build, timeout, permissions, cancelled, unknown) and reports confidence, matched rules, evidence, uncertainties, and next debugging steps. Observed facts and inference are clearly separated; a root cause is never claimed without evidence. No external AI service is called.",
      inputSchema: analyzeWorkflowFailureSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) =>
      runTool(ctx, "analyze_workflow_failure", () => analyzeWorkflowFailure(ctx, input)),
  );
}
