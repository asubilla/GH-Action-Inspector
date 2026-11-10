import { TriageError } from "../src/errors.js";
import type {
  ContentsAccess,
  GitHubReader,
  JobListResult,
  JobSummary,
  ListWorkflowRunsParams,
  LogPayload,
  RateLimitInfo,
  RepositoryLookup,
  RunListResult,
  WorkflowFileInfo,
  WorkflowInfo,
  WorkflowRunSummary,
} from "../src/github/types.js";

/**
 * In-memory reader for the synthetic demo. It performs no network calls and
 * contains no real repository data, logs, or credentials.
 */
export class SyntheticGitHubReader implements GitHubReader {
  readonly repository = {
    id: 1,
    fullName: "example-org/synthetic-demo",
    private: false,
    defaultBranch: "main",
    archived: false,
    disabled: false,
    url: "https://github.com/example-org/synthetic-demo",
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
  };

  readonly runs: WorkflowRunSummary[] = [
    {
      id: 4242,
      name: "CI",
      displayTitle: "Add greeting formatter",
      workflowId: 12,
      path: ".github/workflows/ci.yml",
      runNumber: 17,
      attempt: 1,
      event: "pull_request",
      status: "completed",
      conclusion: "failure",
      branch: "feature/greeting",
      headSha: "fedcba9876543210fedcba9876543210fedcba98",
      headShaShort: "fedcba9",
      createdAt: "2026-02-01T09:00:00Z",
      updatedAt: "2026-02-01T09:04:30Z",
      startedAt: "2026-02-01T09:00:10Z",
      url: "https://github.com/example-org/synthetic-demo/actions/runs/4242",
      actor: "octocat",
    },
    {
      id: 4200,
      name: "CI",
      displayTitle: "Add greeting formatter",
      workflowId: 12,
      path: ".github/workflows/ci.yml",
      runNumber: 16,
      attempt: 1,
      event: "pull_request",
      status: "completed",
      conclusion: "success",
      branch: "feature/greeting",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      headShaShort: "0123456",
      createdAt: "2026-01-31T16:00:00Z",
      updatedAt: "2026-01-31T16:03:00Z",
      startedAt: "2026-01-31T16:00:10Z",
      url: "https://github.com/example-org/synthetic-demo/actions/runs/4200",
      actor: "octocat",
    },
  ];

  readonly jobs: JobSummary[] = [
    {
      id: 9001,
      runId: 4242,
      runAttempt: 1,
      name: "test",
      status: "completed",
      conclusion: "failure",
      startedAt: "2026-02-01T09:00:20Z",
      completedAt: "2026-02-01T09:04:00Z",
      durationSeconds: 220,
      url: "https://github.com/example-org/synthetic-demo/actions/runs/4242/job/9001",
      stepsCount: 5,
      failedSteps: [
        {
          number: 4,
          name: "Run unit tests",
          status: "completed",
          conclusion: "failure",
          startedAt: "2026-02-01T09:01:00Z",
          completedAt: "2026-02-01T09:03:50Z",
        },
      ],
    },
    {
      id: 9002,
      runId: 4242,
      runAttempt: 1,
      name: "lint",
      status: "completed",
      conclusion: "success",
      startedAt: "2026-02-01T09:00:20Z",
      completedAt: "2026-02-01T09:01:05Z",
      durationSeconds: 45,
      url: "https://github.com/example-org/synthetic-demo/actions/runs/4242/job/9002",
      stepsCount: 4,
      failedSteps: [],
    },
  ];

  readonly log = [
    "2026-02-01T09:01:00.0000000Z ##[group]Run unit tests",
    "2026-02-01T09:01:00.0000000Z > vitest run",
    "2026-02-01T09:01:04.0000000Z  FAIL  src/greeting.test.ts > greeting > formats a name",
    "2026-02-01T09:01:04.0000000Z  AssertionError: expected 'Hello, Ada!' to be 'Hi, Ada!'",
    "2026-02-01T09:01:04.0000000Z   at src/greeting.test.ts:8:20",
    "2026-02-01T09:01:04.0000000Z  Tests  1 failed | 11 passed (12)",
    "2026-02-01T09:01:05.0000000Z ##[error]Process completed with exit code 1.",
    "2026-02-01T09:01:05.0000000Z DEBUG token=*** (already masked by GitHub)",
  ].join("\n");

  async getRepository(): Promise<RepositoryLookup> {
    return {
      repository: this.repository,
      meta: {
        scopes: [],
        rateLimit: this.rateLimit(),
        requestId: "SYNTHETIC-DEMO",
      },
    };
  }

  async getAuthenticatedUser(): Promise<{ login: string }> {
    return { login: "synthetic-user" };
  }

  async listWorkflowRuns(params: ListWorkflowRunsParams): Promise<RunListResult> {
    const filtered = this.runs
      .filter((run) => params.workflowId === undefined || run.workflowId === params.workflowId)
      .filter((run) => params.branch === undefined || run.branch === params.branch)
      .filter((run) => {
        if (params.status === undefined) return true;
        return run.status === params.status || run.conclusion === params.status;
      })
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
    return {
      totalCount: filtered.length,
      runs: filtered.slice(0, params.limit),
      meta: { scopes: [], rateLimit: this.rateLimit(), requestId: "SYNTHETIC-DEMO" },
    };
  }

  async getWorkflowRun(_owner: string, _repo: string, runId: number): Promise<WorkflowRunSummary> {
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) {
      throw new TriageError("NOT_FOUND", "Synthetic run not found.", { hint: "Demo data only." });
    }
    return run;
  }

  async listJobsForRun(_owner: string, _repo: string, runId: number): Promise<JobListResult> {
    const jobs = runId === 4242 ? this.jobs : [];
    return { totalCount: jobs.length, jobs, truncated: false };
  }

  async getJob(_owner: string, _repo: string, jobId: number): Promise<JobSummary> {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (job === undefined) {
      throw new TriageError("NOT_FOUND", "Synthetic job not found.", { hint: "Demo data only." });
    }
    return job;
  }

  async getJobLog(_owner: string, _repo: string, jobId: number): Promise<LogPayload> {
    if (jobId !== 9001) {
      throw new TriageError("LOG_UNAVAILABLE", "Synthetic log not available.", {
        hint: "Demo data only.",
      });
    }
    return { text: this.log, downloadedBytes: this.log.length, truncatedBySize: false };
  }

  async getWorkflow(_owner: string, _repo: string, workflowId: number): Promise<WorkflowInfo> {
    if (workflowId !== 12) {
      throw new TriageError("NOT_FOUND", "Synthetic workflow not found.", {
        hint: "Demo data only.",
      });
    }
    return {
      id: 12,
      name: "CI",
      path: ".github/workflows/ci.yml",
      state: "active",
      url: "https://github.com/example-org/synthetic-demo/actions/workflows/12",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-02-01T00:00:00Z",
    };
  }

  async getWorkflowFile(_owner: string, _repo: string, path: string): Promise<WorkflowFileInfo> {
    if (path !== ".github/workflows/ci.yml") {
      throw new TriageError("NOT_FOUND", "Synthetic workflow file not found.", {
        hint: "Demo data only.",
      });
    }
    const content = [
      "name: CI",
      "on: [push, pull_request]",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - run: npm ci",
      "      - run: npm test",
      "",
    ].join("\n");
    return {
      path,
      sha: "synthetic0000000000000000000000000000000000",
      sizeBytes: content.length,
      htmlUrl: "https://github.com/example-org/synthetic-demo/blob/main/.github/workflows/ci.yml",
      contentBase64: Buffer.from(content, "utf8").toString("base64"),
      encoding: "base64",
    };
  }

  async getRateLimit(): Promise<RateLimitInfo> {
    return this.rateLimit();
  }

  async checkContentsAccess(): Promise<ContentsAccess> {
    return { readable: true, status: "readable", detail: "Synthetic demo reader." };
  }

  private rateLimit(): RateLimitInfo {
    return {
      resource: "core",
      limit: 5000,
      used: 12,
      remaining: 4988,
      resetAt: "2026-02-01T10:00:00Z",
    };
  }
}
