/** Domain types returned by the GitHub reader. Raw API envelopes never leave this layer. */

export interface RepositoryPermissions {
  admin: boolean;
  maintain: boolean;
  push: boolean;
  triage: boolean;
  pull: boolean;
}

export interface RepositoryInfo {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  archived: boolean;
  disabled: boolean;
  url: string | null;
  permissions: RepositoryPermissions | null;
}

export interface WorkflowRunSummary {
  id: number;
  name: string;
  displayTitle: string | null;
  workflowId: number;
  path: string | null;
  runNumber: number | null;
  attempt: number;
  event: string;
  status: string | null;
  conclusion: string | null;
  branch: string | null;
  headSha: string | null;
  headShaShort: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  url: string | null;
  actor: string | null;
}

export interface StepSummary {
  number: number | null;
  name: string;
  status: string | null;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobSummary {
  id: number;
  runId: number | null;
  runAttempt: number | null;
  name: string;
  status: string | null;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  url: string | null;
  stepsCount: number;
  failedSteps: StepSummary[];
}

export interface WorkflowInfo {
  id: number;
  name: string;
  path: string;
  state: string;
  url: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorkflowFileInfo {
  path: string;
  sha: string | null;
  sizeBytes: number | null;
  htmlUrl: string | null;
  contentBase64: string | null;
  encoding: string | null;
}

export interface LogPayload {
  text: string;
  downloadedBytes: number;
  truncatedBySize: boolean;
}

export interface RateLimitInfo {
  resource: string;
  limit: number;
  used: number;
  remaining: number;
  resetAt: string | null;
}

export interface ResponseMeta {
  scopes: string[];
  rateLimit: RateLimitInfo | null;
  requestId: string | null;
}

export interface RepositoryLookup {
  repository: RepositoryInfo;
  meta: ResponseMeta;
}

export interface RunListResult {
  totalCount: number;
  runs: WorkflowRunSummary[];
  meta: ResponseMeta;
}

export interface JobListResult {
  totalCount: number;
  jobs: JobSummary[];
  truncated: boolean;
}

export interface ContentsAccess {
  readable: boolean;
  status: "readable" | "forbidden" | "not_found" | "unknown";
  detail: string;
}

export interface ListWorkflowRunsParams {
  owner: string;
  repo: string;
  /** When set, queries /actions/workflows/{id}/runs instead of the repository-wide run list. */
  workflowId?: number | undefined;
  branch?: string | undefined;
  status?: string | undefined;
  event?: string | undefined;
  createdAfter?: string | undefined;
  createdBefore?: string | undefined;
  limit: number;
  page?: number | undefined;
}

/**
 * Every method is a read. There is deliberately no request method that accepts
 * an HTTP verb, and no write-capable endpoint is implemented anywhere.
 */
export interface GitHubReader {
  getRepository(owner: string, repo: string): Promise<RepositoryLookup>;
  getAuthenticatedUser(): Promise<{ login: string }>;
  listWorkflowRuns(params: ListWorkflowRunsParams): Promise<RunListResult>;
  getWorkflowRun(owner: string, repo: string, runId: number): Promise<WorkflowRunSummary>;
  listJobsForRun(
    owner: string,
    repo: string,
    runId: number,
    options?: { maxPages?: number },
  ): Promise<JobListResult>;
  getJob(owner: string, repo: string, jobId: number): Promise<JobSummary>;
  getJobLog(owner: string, repo: string, jobId: number): Promise<LogPayload>;
  getWorkflow(owner: string, repo: string, workflowId: number): Promise<WorkflowInfo>;
  getWorkflowFile(
    owner: string,
    repo: string,
    path: string,
    ref: string | undefined,
  ): Promise<WorkflowFileInfo>;
  getRateLimit(): Promise<RateLimitInfo>;
  checkContentsAccess(owner: string, repo: string): Promise<ContentsAccess>;
}
