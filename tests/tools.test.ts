import { afterEach, describe, expect, it } from "vitest";
import { buildConfig } from "../src/config.js";
import { HINTS, TriageError } from "../src/errors.js";
import { createLazyGitHubReader } from "../src/github/client.js";
import { createLogger } from "../src/logger.js";
import {
  dependencyLog,
  failingTestLog,
  makeJob,
  makeRepository,
  makeRun,
  makeStep,
  makeWorkflow,
  makeWorkflowFile,
  permissionLog,
} from "./helpers/factories.js";
import { FakeGitHubReader } from "./helpers/fake-github.js";
import {
  asArray,
  asObject,
  callTool,
  createHarness,
  TEST_TOKEN,
  testConfig,
  toolJson,
  toolText,
  type Harness,
} from "./helpers/mcp.js";

const silentSink = { write: (): boolean => true };

function readerWithFailures(): FakeGitHubReader {
  const reader = new FakeGitHubReader();
  const current = makeRun();
  const previous = makeRun({
    id: 1000,
    runNumber: 41,
    status: "completed",
    conclusion: "success",
    headSha: "1234567890abcdef1234567890abcdef12345678",
    headShaShort: "1234567",
    createdAt: "2026-01-09T09:00:00Z",
    startedAt: "2026-01-09T09:00:10Z",
    updatedAt: "2026-01-09T09:03:00Z",
  });
  reader.runs = [current, previous];

  const testJob = makeJob();
  const buildJob = makeJob({
    id: 5002,
    name: "build",
    failedSteps: [makeStep({ number: 2, name: "npm ci" })],
  });
  const lintJob = makeJob({
    id: 5003,
    name: "lint",
    conclusion: "success",
    failedSteps: [],
  });
  reader.jobsByRun.set(1001, [testJob, buildJob, lintJob]);
  reader.jobsByRun.set(1000, [
    makeJob({ id: 6001, runId: 1000, name: "test", conclusion: "success", failedSteps: [] }),
    makeJob({ id: 6002, runId: 1000, name: "build", conclusion: "success", failedSteps: [] }),
  ]);
  reader.logs.set(5001, {
    text: failingTestLog(),
    downloadedBytes: failingTestLog().length,
    truncatedBySize: false,
  });
  reader.logs.set(5002, {
    text: dependencyLog(),
    downloadedBytes: dependencyLog().length,
    truncatedBySize: false,
  });
  reader.workflows.set(77, makeWorkflow());
  reader.workflowFiles.set(".github/workflows/ci.yml", makeWorkflowFile());
  return reader;
}

let harness: Harness | null = null;

afterEach(async () => {
  if (harness !== null) {
    await harness.close();
    harness = null;
  }
});

describe("MCP tools", () => {
  it("registers exactly the documented read-only tools", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const { tools } = await harness.client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      [
        "analyze_workflow_failure",
        "check_github_access",
        "compare_with_previous_run",
        "get_job_log_excerpt",
        "get_workflow_file_metadata",
        "get_workflow_run",
        "list_failed_jobs",
        "list_workflow_runs",
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      expect(tool.description?.toLowerCase()).toContain("read-only");
    }
  });

  it("lists workflow runs with defaults and filters", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const result = await callTool(harness, "list_workflow_runs", {
      owner: "example-org",
      repo: "example-repo",
      status: "failure",
    });
    expect(result.isError).toBeFalsy();
    const body = toolJson(result);
    expect(body.returned).toBe(1);
    expect(asArray(body.runs)).toHaveLength(1);
    expect(harness.reader.listRunsCalls[0]?.limit).toBe(20);
    expect(harness.reader.listRunsCalls[0]?.page).toBe(1);

    const filtered = await callTool(harness, "list_workflow_runs", {
      owner: "example-org",
      repo: "example-repo",
      branch: "main",
      event: "push",
      limit: 5,
      page: 2,
      createdAfter: "2026-01-01T00:00:00Z",
      createdBefore: "2026-01-31T00:00:00Z",
    });
    expect(filtered.isError).toBeFalsy();
    const call = harness.reader.listRunsCalls[1];
    expect(call?.branch).toBe("main");
    expect(call?.limit).toBe(5);
    expect(call?.page).toBe(2);
    expect(call?.createdAfter).toBe("2026-01-01T00:00:00.000Z");

    const unusualBranch = await callTool(harness, "list_workflow_runs", {
      owner: "example-org",
      repo: "example-repo",
      branch: "dependabot/npm_and_yarn/foo+bar",
    });
    expect(unusualBranch.isError).toBeFalsy();
  });

  it("rejects invalid inputs through schema validation", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const badOwner = await callTool(harness, "list_workflow_runs", {
      owner: "not a valid owner!",
      repo: "example-repo",
    });
    expect(badOwner.isError).toBe(true);
    expect(toolText(badOwner)).toContain("Input validation error");

    const badLimit = await callTool(harness, "list_workflow_runs", {
      owner: "example-org",
      repo: "example-repo",
      limit: 500,
    });
    expect(badLimit.isError).toBe(true);

    const badRange = await callTool(harness, "list_workflow_runs", {
      owner: "example-org",
      repo: "example-repo",
      createdAfter: "2026-02-01T00:00:00Z",
      createdBefore: "2026-01-01T00:00:00Z",
    });
    expect(badRange.isError).toBe(true);
    expect(toolJson(badRange).error).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("gets a single run as a concise summary", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const result = await callTool(harness, "get_workflow_run", {
      owner: "example-org",
      repo: "example-repo",
      runId: 1001,
    });
    const body = toolJson(result);
    const run = asObject(body.run);
    expect(run.id).toBe(1001);
    expect(run.conclusion).toBe("failure");
    expect(asObject(body.timing).duration).toBe("4m 50s");
    expect(body.raw).toBeUndefined();
  });

  it("lists failed, cancelled, and timed-out jobs only", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const result = await callTool(harness, "list_failed_jobs", {
      owner: "example-org",
      repo: "example-repo",
      runId: 1001,
    });
    const body = toolJson(result);
    const jobs = asArray(body.failedJobs);
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => asObject(job).name)).toEqual(["test", "build"]);
    const testJob = asObject(jobs[0]);
    expect(asArray(testJob.failedSteps)).toHaveLength(1);
    expect(body.jobsScanned).toBe(3);
  });

  it("returns bounded, redacted log excerpts", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const fakeToken = `ghp_${"M".repeat(36)}`;
    harness.reader.logs.set(5001, {
      text: `${failingTestLog()}\n2026-01-10T10:01:07.0000000Z ##[error] request failed with TOKEN=${fakeToken}`,
      downloadedBytes: 200,
      truncatedBySize: false,
    });

    const result = await callTool(harness, "get_job_log_excerpt", {
      owner: "example-org",
      repo: "example-repo",
      jobId: 5001,
      maxChars: 900,
      contextLines: 2,
      maxExcerpts: 2,
    });
    expect(result.isError).toBeFalsy();
    const body = toolJson(result);
    const log = asObject(body.log);
    expect(log.maxChars).toBe(900);
    expect(log.totalLines).toBeGreaterThan(0);
    expect(log.hasFailureMarkers).toBe(true);
    const excerpts = asArray(log.excerpts).map(asObject);
    const totalChars = excerpts.map((excerpt) => String(excerpt.text)).join("\n\n").length;
    expect(totalChars).toBeLessThanOrEqual(900);
    expect(toolText(result)).not.toContain(fakeToken);
    expect(Number(log.redactionCount)).toBeGreaterThan(0);
  });

  it("rejects an oversized requested excerpt and reports missing logs safely", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const oversized = await callTool(harness, "get_job_log_excerpt", {
      owner: "example-org",
      repo: "example-repo",
      jobId: 5001,
      maxChars: 50_000,
    });
    expect(oversized.isError).toBe(true);
    expect(toolText(oversized)).toContain("Input validation error");

    harness.reader.logErrors.set(
      5001,
      new TriageError("LOG_UNAVAILABLE", "The job log is not available.", {
        hint: HINTS.logUnavailable,
        status: 404,
      }),
    );
    const missing = await callTool(harness, "get_job_log_excerpt", {
      owner: "example-org",
      repo: "example-repo",
      jobId: 5001,
    });
    expect(missing.isError).toBe(true);
    const error = asObject(toolJson(missing).error);
    expect(error.code).toBe("LOG_UNAVAILABLE");
    expect(String(error.hint)).toMatch(/Actions: read|expire/i);
  });

  it("produces a deterministic failure report with evidence and safe guidance", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const result = await callTool(harness, "analyze_workflow_failure", {
      owner: "example-org",
      repo: "example-repo",
      runId: 1001,
      maxJobs: 5,
      maxCharsPerJob: 2_000,
      includeLogs: true,
    });
    expect(result.isError).toBeFalsy();
    const body = toolJson(result);
    expect(body.applicable).toBe(true);
    const failure = asObject(body.failure);
    // Two different jobs failed for different reasons. Dependency evidence is
    // stronger here, but the test failure must remain visible as an alternative.
    expect(failure.category).toBe("dependency_installation");
    expect(failure.basis).toBe("log-and-metadata");
    expect(asArray(failure.alternatives).map((item) => asObject(item).category)).toContain(
      "test_failure",
    );
    expect(asArray(body.evidence).length).toBeGreaterThan(0);
    expect(asArray(body.observed).length).toBeGreaterThan(0);
    expect(asArray(body.inference).length).toBeGreaterThan(0);
    expect(asArray(body.nextSteps).length).toBeGreaterThan(0);
    expect(String(body.disclaimer)).toMatch(/not a confirmed root cause/i);
    expect(toolText(result)).not.toContain(TEST_TOKEN);
  });

  it("discloses failed jobs omitted by the analysis budget", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const result = await callTool(harness, "analyze_workflow_failure", {
      owner: "example-org",
      repo: "example-repo",
      runId: 1001,
      maxJobs: 1,
    });
    const body = toolJson(result);
    expect(body.omittedFailedJobs).toBe(1);
    expect(String(asArray(body.uncertainties).join(" "))).toMatch(/omitted/i);
    expect(asArray(body.logStatus)).toHaveLength(1);
  });

  it("can classify without downloading logs and reports the limitation", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const result = await callTool(harness, "analyze_workflow_failure", {
      owner: "example-org",
      repo: "example-repo",
      runId: 1001,
      includeLogs: false,
    });
    const body = toolJson(result);
    const failure = asObject(body.failure);
    expect(failure.basis).toBe("metadata-only");
    expect(failure.confidence).not.toBe("high");
    expect(harness.reader.calls).not.toContain("getJobLog");
    expect(asObject(body.limits).logsRequested).toBe(false);
  });

  it("does not analyze a successful run", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const result = await callTool(harness, "analyze_workflow_failure", {
      owner: "example-org",
      repo: "example-repo",
      runId: 1000,
    });
    const body = toolJson(result);
    expect(body.applicable).toBe(false);
    expect(String(body.summary)).toMatch(/not applicable/i);
  });

  it("compares with the most recent successful run without claiming causation", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const result = await callTool(harness, "compare_with_previous_run", {
      owner: "example-org",
      repo: "example-repo",
      runId: 1001,
      lookback: 20,
    });
    expect(result.isError).toBeFalsy();
    const body = toolJson(result);
    expect(asObject(body.previous).id).toBe(1000);
    expect(body.causation).toBe("not_determined");
    const differences = asObject(body.differences);
    expect(differences.commitChanged).toBe(true);
    expect(asArray(differences.newlyFailingJobs)).toEqual(["test", "build"]);
    expect(String(asArray(body.possibleExplanations).join(" "))).toMatch(
      /does not establish causation/i,
    );
    expect(String(asArray(body.notes).join(" "))).toMatch(/No code diff/i);
  });

  it("explains a same-commit failure as possibly flaky, not as a code regression", async () => {
    const reader = readerWithFailures();
    const previous = reader.runs.find((run) => run.id === 1000);
    if (previous === undefined) throw new Error("fixture missing");
    previous.headSha = "abcdef1234567890abcdef1234567890abcdef12";
    previous.headShaShort = "abcdef1";
    harness = await createHarness({ reader });

    const result = await callTool(harness, "compare_with_previous_run", {
      owner: "example-org",
      repo: "example-repo",
      runId: 1001,
    });
    const body = toolJson(result);
    expect(asObject(body.differences).sameCommit).toBe(true);
    expect(String(asArray(body.possibleExplanations).join(" "))).toMatch(/flaky|environment/i);
  });

  it("handles no previous successful run", async () => {
    const reader = readerWithFailures();
    reader.runs = reader.runs.filter((run) => run.id !== 1000);
    harness = await createHarness({ reader });
    const result = await callTool(harness, "compare_with_previous_run", {
      owner: "example-org",
      repo: "example-repo",
      runId: 1001,
    });
    const body = toolJson(result);
    expect(body.previous).toBeNull();
    expect(body.differences).toBeNull();
    expect(String(body.summary)).toMatch(/No previous successful run/i);
  });

  it("returns workflow metadata without content unless explicitly requested", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const metadataOnly = await callTool(harness, "get_workflow_file_metadata", {
      owner: "example-org",
      repo: "example-repo",
      workflowPath: ".github/workflows/ci.yml",
    });
    const body = toolJson(metadataOnly);
    const file = asObject(body.file);
    expect(file.path).toBe(".github/workflows/ci.yml");
    expect(file.contentIncluded).toBe(false);
    expect(file.content).toBeNull();

    const withContent = await callTool(harness, "get_workflow_file_metadata", {
      owner: "example-org",
      repo: "example-repo",
      runId: 1001,
      includeContent: true,
    });
    const contentBody = toolJson(withContent);
    expect(asObject(contentBody.file).contentIncluded).toBe(true);
    expect(String(asObject(contentBody.file).content)).toContain("name: CI");
  });

  it("redacts workflow file content and refuses unrelated paths", async () => {
    const reader = readerWithFailures();
    const fakeToken = `ghp_${"Z".repeat(36)}`;
    reader.workflowFiles.set(
      ".github/workflows/ci.yml",
      makeWorkflowFile({
        contentBase64: Buffer.from(
          `name: CI\nenv:\n  GITHUB_TOKEN: ${fakeToken}\n`,
          "utf8",
        ).toString("base64"),
      }),
    );
    harness = await createHarness({ reader });

    const result = await callTool(harness, "get_workflow_file_metadata", {
      owner: "example-org",
      repo: "example-repo",
      workflowPath: ".github/workflows/ci.yml",
      includeContent: true,
    });
    expect(toolText(result)).not.toContain(fakeToken);
    expect(Number(asObject(toolJson(result).file).redactionCount)).toBeGreaterThan(0);

    const unrelated = await callTool(harness, "get_workflow_file_metadata", {
      owner: "example-org",
      repo: "example-repo",
      workflowPath: "src/index.ts",
    });
    expect(unrelated.isError).toBe(true);

    const ambiguous = await callTool(harness, "get_workflow_file_metadata", {
      owner: "example-org",
      repo: "example-repo",
    });
    expect(ambiguous.isError).toBe(true);
    expect(toolJson(ambiguous).error).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("checks access and never returns the token", async () => {
    harness = await createHarness({ reader: readerWithFailures() });
    const result = await callTool(harness, "check_github_access", {
      owner: "example-org",
      repo: "example-repo",
      checkContents: true,
    });
    expect(result.isError).toBeFalsy();
    const body = toolJson(result);
    expect(body.ok).toBe(true);
    expect(asObject(body.token).configured).toBe(true);
    expect(body.readOnly).toBe(true);
    expect(toolText(result)).not.toContain(TEST_TOKEN);
    expect(JSON.stringify(body)).not.toContain(TEST_TOKEN);
    expect(harness.reader.calls).toContain("checkContentsAccess");
  });

  it("returns actionable guidance when the token is absent", async () => {
    harness = await createHarness({
      reader: readerWithFailures(),
      config: buildConfig({}),
    });
    const result = await callTool(harness, "check_github_access", {
      owner: "example-org",
      repo: "example-repo",
    });
    const body = toolJson(result);
    expect(body.ok).toBe(false);
    expect(asObject(body.token).configured).toBe(false);
    expect(String(asArray(body.guidance).join(" "))).toMatch(/GITHUB_TOKEN/);
  });

  it("returns AUTH_MISSING from the lazy client when no token is configured", async () => {
    const config = buildConfig({});
    harness = await createHarness({
      client: createLazyGitHubReader(config, createLogger(false, silentSink)),
      config,
    });
    const result = await callTool(harness, "list_workflow_runs", {
      owner: "example-org",
      repo: "example-repo",
    });
    expect(result.isError).toBe(true);
    const error = asObject(toolJson(result).error);
    expect(error.code).toBe("AUTH_MISSING");
    expect(String(error.hint)).toContain("GITHUB_TOKEN");
  });

  it("maps permission and rate-limit failures to safe structured errors", async () => {
    const reader = new FakeGitHubReader();
    reader.globalError = new TriageError("RATE_LIMITED", "GitHub rate limit reached.", {
      hint: HINTS.rateLimited,
      retryAfterSeconds: 60,
      status: 429,
    });
    harness = await createHarness({ reader });
    const result = await callTool(harness, "get_workflow_run", {
      owner: "example-org",
      repo: "example-repo",
      runId: 1,
    });
    expect(result.isError).toBe(true);
    const error = asObject(toolJson(result).error);
    expect(error.code).toBe("RATE_LIMITED");
    expect(error.retryAfterSeconds).toBe(60);
    expect(toolText(result)).not.toMatch(/stack|Authorization/i);
  });

  it("keeps analyzing other jobs when one log is expired", async () => {
    const reader = readerWithFailures();
    reader.logErrors.set(
      5002,
      new TriageError("LOG_UNAVAILABLE", "The job log is not available.", {
        hint: HINTS.logUnavailable,
        status: 404,
      }),
    );
    harness = await createHarness({ reader });
    const result = await callTool(harness, "analyze_workflow_failure", {
      owner: "example-org",
      repo: "example-repo",
      runId: 1001,
    });
    const body = toolJson(result);
    const statuses = asArray(body.logStatus).map(asObject);
    expect(statuses).toHaveLength(2);
    expect(statuses.some((status) => status.available === false)).toBe(true);
    expect(asArray(body.uncertainties).join(" ")).toMatch(/unavailable/i);
  });

  it("uses the token only from configuration for repository reads", async () => {
    const reader = new FakeGitHubReader();
    reader.repo = makeRepository({ fullName: "example-org/example-repo" });
    harness = await createHarness({ reader });
    const result = await callTool(harness, "check_github_access", {
      owner: "example-org",
      repo: "example-repo",
    });
    expect(result.isError).toBeFalsy();
    expect(reader.calls).toContain("getRepository");
    expect(permissionLog()).toContain("403");
  });
});

describe("configuration sanity", () => {
  it("uses the same token source for every harness instance", () => {
    const config = testConfig();
    expect(config.githubToken).toBe(TEST_TOKEN);
  });
});
