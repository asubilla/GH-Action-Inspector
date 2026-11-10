/**
 * SYNTHETIC DEMO — no network, no GitHub token, no real repository data.
 *
 * Run with: npm run demo
 */
import { buildConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { analyzeWorkflowFailure } from "../src/tools/analyze-workflow-failure.js";
import { compareWithPreviousRun } from "../src/tools/compare-with-previous-run.js";
import { getJobLogExcerpt } from "../src/tools/get-job-log-excerpt.js";
import { listFailedJobs } from "../src/tools/list-failed-jobs.js";
import { listWorkflowRuns } from "../src/tools/list-workflow-runs.js";
import { SyntheticGitHubReader } from "./synthetic-reader.js";

const config = buildConfig({ githubToken: "synthetic-demo-token-not-used" });
const ctx = {
  client: new SyntheticGitHubReader(),
  config,
  logger: createLogger(false, { write: (): boolean => true }),
};

function heading(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

async function main(): Promise<void> {
  console.log("SYNTHETIC DEMO — all data below is fabricated for illustration.");
  console.log("No GitHub API calls are made and no credential is used.");

  heading("1. list_workflow_runs (status=failure)");
  const runs = await listWorkflowRuns(ctx, {
    owner: "example-org",
    repo: "synthetic-demo",
    status: "failure",
    limit: 5,
    page: 1,
  });
  console.log(JSON.stringify(runs, null, 2));

  heading("2. list_failed_jobs");
  const jobs = await listFailedJobs(ctx, {
    owner: "example-org",
    repo: "synthetic-demo",
    runId: 4242,
  });
  console.log(JSON.stringify(jobs, null, 2));

  heading("3. get_job_log_excerpt (redacted and size-capped)");
  const excerpt = await getJobLogExcerpt(ctx, {
    owner: "example-org",
    repo: "synthetic-demo",
    jobId: 9001,
    maxChars: 1_200,
    contextLines: 2,
    maxExcerpts: 2,
  });
  console.log(JSON.stringify(excerpt, null, 2));

  heading("4. analyze_workflow_failure (observed evidence vs inference)");
  const report = await analyzeWorkflowFailure(ctx, {
    owner: "example-org",
    repo: "synthetic-demo",
    runId: 4242,
    maxJobs: 5,
    maxCharsPerJob: 2_000,
    includeLogs: true,
  });
  console.log(JSON.stringify(report, null, 2));

  heading("5. compare_with_previous_run (no causation claim)");
  const comparison = await compareWithPreviousRun(ctx, {
    owner: "example-org",
    repo: "synthetic-demo",
    runId: 4242,
    lookback: 20,
  });
  console.log(JSON.stringify(comparison, null, 2));

  heading("Done");
  console.log("This demo used only in-memory synthetic data.");
  console.log("Next: set GITHUB_TOKEN and configure your MCP client with:");
  console.log("  gh-action-inspector setup --client cursor --write");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Demo failed.");
  process.exitCode = 1;
});
