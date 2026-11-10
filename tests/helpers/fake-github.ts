import { HINTS, TriageError } from "../../src/errors.js";
import type {
  ContentsAccess,
  GitHubReader,
  JobListResult,
  JobSummary,
  ListWorkflowRunsParams,
  LogPayload,
  RateLimitInfo,
  RepositoryLookup,
  ResponseMeta,
  RunListResult,
  WorkflowFileInfo,
  WorkflowInfo,
  WorkflowRunSummary,
} from "../../src/github/types.js";
import { makeRepository } from "./factories.js";

const EMPTY_META: ResponseMeta = { scopes: [], rateLimit: null, requestId: null };

export class FakeGitHubReader implements GitHubReader {
  repo = makeRepository();
  runs: WorkflowRunSummary[] = [];
  jobsByRun = new Map<number, JobSummary[]>();
  logs = new Map<number, LogPayload>();
  logErrors = new Map<number, TriageError>();
  workflows = new Map<number, WorkflowInfo>();
  workflowFiles = new Map<string, WorkflowFileInfo>();
  rateLimit: RateLimitInfo = {
    resource: "core",
    limit: 5000,
    used: 10,
    remaining: 4990,
    resetAt: "2026-01-10T11:00:00Z",
  };
  contentsAccess: ContentsAccess = {
    readable: true,
    status: "readable",
    detail: "synthetic test reader",
  };
  login = "test-user";
  globalError: TriageError | null = null;
  listRunsError: TriageError | null = null;
  scopes: string[] = [];
  calls: string[] = [];
  listRunsCalls: ListWorkflowRunsParams[] = [];

  private maybeThrow(): void {
    if (this.globalError !== null) throw this.globalError;
  }

  async getRepository(): Promise<RepositoryLookup> {
    this.calls.push("getRepository");
    this.maybeThrow();
    return {
      repository: this.repo,
      meta: { ...EMPTY_META, scopes: this.scopes, rateLimit: this.rateLimit },
    };
  }

  async getAuthenticatedUser(): Promise<{ login: string }> {
    this.calls.push("getAuthenticatedUser");
    this.maybeThrow();
    return { login: this.login };
  }

  async listWorkflowRuns(params: ListWorkflowRunsParams): Promise<RunListResult> {
    this.calls.push("listWorkflowRuns");
    this.listRunsCalls.push(params);
    this.maybeThrow();
    if (this.listRunsError !== null) throw this.listRunsError;

    const filtered = this.runs
      .filter((run) => params.workflowId === undefined || run.workflowId === params.workflowId)
      .filter((run) => params.branch === undefined || run.branch === params.branch)
      .filter((run) => {
        if (params.status === undefined) return true;
        return run.status === params.status || run.conclusion === params.status;
      })
      .filter((run) => {
        if (params.createdAfter === undefined) return true;
        return (
          run.createdAt !== null && Date.parse(run.createdAt) >= Date.parse(params.createdAfter)
        );
      })
      .filter((run) => {
        if (params.createdBefore === undefined) return true;
        return (
          run.createdAt !== null && Date.parse(run.createdAt) <= Date.parse(params.createdBefore)
        );
      })
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

    return {
      totalCount: filtered.length,
      runs: filtered.slice(0, params.limit),
      meta: { ...EMPTY_META, scopes: this.scopes, rateLimit: this.rateLimit },
    };
  }

  async getWorkflowRun(_owner: string, _repo: string, runId: number): Promise<WorkflowRunSummary> {
    this.calls.push("getWorkflowRun");
    this.maybeThrow();
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (run === undefined) {
      throw new TriageError("NOT_FOUND", "The repository, run, or job was not found.", {
        hint: HINTS.notFound,
        status: 404,
      });
    }
    return run;
  }

  async listJobsForRun(_owner: string, _repo: string, runId: number): Promise<JobListResult> {
    this.calls.push("listJobsForRun");
    this.maybeThrow();
    const jobs = this.jobsByRun.get(runId) ?? [];
    return { totalCount: jobs.length, jobs, truncated: false };
  }

  async getJob(_owner: string, _repo: string, jobId: number): Promise<JobSummary> {
    this.calls.push("getJob");
    this.maybeThrow();
    for (const jobs of this.jobsByRun.values()) {
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (job !== undefined) return job;
    }
    throw new TriageError("NOT_FOUND", "The repository, run, or job was not found.", {
      hint: HINTS.notFound,
      status: 404,
    });
  }

  async getJobLog(_owner: string, _repo: string, jobId: number): Promise<LogPayload> {
    this.calls.push("getJobLog");
    this.maybeThrow();
    const error = this.logErrors.get(jobId);
    if (error !== undefined) throw error;
    const log = this.logs.get(jobId);
    if (log === undefined) {
      throw new TriageError("LOG_UNAVAILABLE", "The job log is not available.", {
        hint: HINTS.logUnavailable,
        status: 404,
      });
    }
    return log;
  }

  async getWorkflow(_owner: string, _repo: string, workflowId: number): Promise<WorkflowInfo> {
    this.calls.push("getWorkflow");
    this.maybeThrow();
    const workflow = this.workflows.get(workflowId);
    if (workflow === undefined) {
      throw new TriageError("NOT_FOUND", "The repository, run, or job was not found.", {
        hint: HINTS.notFound,
        status: 404,
      });
    }
    return workflow;
  }

  async getWorkflowFile(
    _owner: string,
    _repo: string,
    path: string,
    _ref: string | undefined,
  ): Promise<WorkflowFileInfo> {
    this.calls.push("getWorkflowFile");
    this.maybeThrow();
    const file = this.workflowFiles.get(path);
    if (file === undefined) {
      throw new TriageError("NOT_FOUND", "The workflow file or repository was not found.", {
        hint: HINTS.notFound,
        status: 404,
      });
    }
    return file;
  }

  async getRateLimit(): Promise<RateLimitInfo> {
    this.calls.push("getRateLimit");
    this.maybeThrow();
    return this.rateLimit;
  }

  async checkContentsAccess(): Promise<ContentsAccess> {
    this.calls.push("checkContentsAccess");
    this.maybeThrow();
    return this.contentsAccess;
  }
}
