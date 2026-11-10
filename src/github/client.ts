import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig } from "../config.js";
import { isLoopbackHost, MAX_JSON_BYTES, MAX_LOG_DOWNLOAD_BYTES } from "../config.js";
import { HINTS, TriageError } from "../errors.js";
import { createLogger, type Logger } from "../logger.js";
import { SERVER_VERSION } from "../version.js";
import {
  mapJob,
  mapRepository,
  mapWorkflow,
  mapWorkflowRun,
  parseRateLimit,
  parseScopes,
  safeHttpUrl,
} from "./mappers.js";
import {
  rawContentFileSchema,
  rawJobListSchema,
  rawJobSchema,
  rawRateLimitSchema,
  rawRepositorySchema,
  rawUserSchema,
  rawWorkflowRunListSchema,
  rawWorkflowRunSchema,
  rawWorkflowSchema,
} from "./schemas.js";
import { discardResponseBody, readResponseTextCapped } from "./read.js";
import type { z } from "zod";
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
} from "./types.js";
import { assertWorkflowPath } from "./workflow-path.js";

const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = `gh-action-inspector/${SERVER_VERSION}`;
const MAX_REDIRECTS = 3;
const JOB_PAGE_SIZE = 100;
const MAX_JOB_PAGES = 3;
const DEFAULT_RETRY_DELAY_MS = 250;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type FetchLike = typeof globalThis.fetch;

export interface GitHubClientOptions {
  fetchImpl?: FetchLike;
  /** Tests set this to 0. Production uses a single short backoff. */
  retryDelayMs?: number;
  logger?: Logger;
}

type QueryValue = string | number | undefined;

interface FetchedResponse {
  response: Response;
  meta: ResponseMeta;
}

interface JsonResult {
  data: unknown;
  meta: ResponseMeta;
}

/**
 * Minimal read-only GitHub REST client.
 *
 * Safety properties:
 * - Only GET requests are implemented; no method accepts an HTTP verb.
 * - Authorization is never forwarded to a different origin (job logs redirect
 *   to pre-signed object storage on another host).
 * - Tokens are never included in errors, logs, or returned metadata.
 * - Responses are size-capped and requests are time-bounded.
 * - Rate limits are reported, never retried in a loop.
 */
export class GitHubClient implements GitHubReader {
  private readonly token: string;
  private readonly apiBaseUrl: string;
  private readonly apiOrigin: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly retryDelayMs: number;
  private readonly logger: Logger;

  constructor(config: AppConfig, options: GitHubClientOptions = {}) {
    if (config.githubToken === undefined) {
      throw new TriageError("AUTH_MISSING", "GITHUB_TOKEN is not configured.", {
        hint: HINTS.authMissing,
      });
    }
    this.token = config.githubToken;
    this.apiBaseUrl = config.apiBaseUrl;
    this.apiOrigin = new URL(config.apiBaseUrl).origin;
    this.timeoutMs = config.requestTimeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.logger = options.logger ?? createLogger(false);
  }

  async getRepository(owner: string, repo: string): Promise<RepositoryLookup> {
    const result = await this.requestJson(`/repos/${segment(owner)}/${segment(repo)}`);
    const raw = parseOrThrow(rawRepositorySchema, result.data);
    return { repository: mapRepository(raw), meta: result.meta };
  }

  async getAuthenticatedUser(): Promise<{ login: string }> {
    const result = await this.requestJson("/user");
    const raw = parseOrThrow(rawUserSchema, result.data);
    return { login: raw.login };
  }

  async listWorkflowRuns(params: ListWorkflowRunsParams): Promise<RunListResult> {
    const limit = Math.min(100, Math.max(1, Math.trunc(params.limit)));
    const runsPath =
      params.workflowId === undefined
        ? `/repos/${segment(params.owner)}/${segment(params.repo)}/actions/runs`
        : `/repos/${segment(params.owner)}/${segment(params.repo)}/actions/workflows/${params.workflowId}/runs`;
    const result = await this.requestJson(runsPath, {
      per_page: limit,
      page: Math.max(1, Math.trunc(params.page ?? 1)),
      branch: params.branch,
      status: params.status,
      event: params.event,
      created: buildCreatedFilter(params.createdAfter, params.createdBefore),
    });
    const raw = parseOrThrow(rawWorkflowRunListSchema, result.data);
    const runs = raw.workflow_runs
      .map(mapWorkflowRun)
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, limit);
    return {
      totalCount: Math.max(raw.total_count, raw.workflow_runs.length),
      runs,
      meta: result.meta,
    };
  }

  async getWorkflowRun(owner: string, repo: string, runId: number): Promise<WorkflowRunSummary> {
    const result = await this.requestJson(
      `/repos/${segment(owner)}/${segment(repo)}/actions/runs/${runId}`,
    );
    return mapWorkflowRun(parseOrThrow(rawWorkflowRunSchema, result.data));
  }

  async listJobsForRun(
    owner: string,
    repo: string,
    runId: number,
    options: { maxPages?: number } = {},
  ): Promise<JobListResult> {
    const maxPages = Math.min(MAX_JOB_PAGES, Math.max(1, options.maxPages ?? MAX_JOB_PAGES));
    const jobs: JobSummary[] = [];
    let totalCount = 0;

    for (let page = 1; page <= maxPages; page += 1) {
      const result = await this.requestJson(
        `/repos/${segment(owner)}/${segment(repo)}/actions/runs/${runId}/jobs`,
        { per_page: JOB_PAGE_SIZE, page, filter: "latest" },
      );
      const raw = parseOrThrow(rawJobListSchema, result.data);
      totalCount = Math.max(totalCount, raw.total_count);
      jobs.push(...raw.jobs.map(mapJob));
      if (raw.jobs.length < JOB_PAGE_SIZE || jobs.length >= totalCount) break;
    }

    const truncated = jobs.length < totalCount;
    return {
      totalCount,
      jobs: jobs.slice(0, JOB_PAGE_SIZE * MAX_JOB_PAGES),
      truncated,
    };
  }

  async getJob(owner: string, repo: string, jobId: number): Promise<JobSummary> {
    const result = await this.requestJson(
      `/repos/${segment(owner)}/${segment(repo)}/actions/jobs/${jobId}`,
    );
    return mapJob(parseOrThrow(rawJobSchema, result.data));
  }

  async getJobLog(owner: string, repo: string, jobId: number): Promise<LogPayload> {
    const url = this.buildUrl(
      `/repos/${segment(owner)}/${segment(repo)}/actions/jobs/${jobId}/logs`,
    );
    const fetched = await this.fetchFollowingRedirects(url, {
      authenticated: true,
      accept: "application/vnd.github+json",
    });

    if (!fetched.response.ok) {
      await discardResponseBody(fetched.response);
      throw this.mapResponseError(fetched.response, fetched.meta, "logs");
    }

    const contentType = fetched.response.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      await discardResponseBody(fetched.response);
      throw new TriageError(
        "LOG_UNAVAILABLE",
        "GitHub returned an HTML page instead of a job log.",
        { hint: HINTS.logUnavailable, status: fetched.response.status },
      );
    }

    const body = await readResponseTextCapped(fetched.response, MAX_LOG_DOWNLOAD_BYTES);
    return {
      text: body.text,
      downloadedBytes: body.downloadedBytes,
      truncatedBySize: body.truncated,
    };
  }

  async getWorkflow(owner: string, repo: string, workflowId: number): Promise<WorkflowInfo> {
    const result = await this.requestJson(
      `/repos/${segment(owner)}/${segment(repo)}/actions/workflows/${workflowId}`,
    );
    return mapWorkflow(parseOrThrow(rawWorkflowSchema, result.data));
  }

  async getWorkflowFile(
    owner: string,
    repo: string,
    path: string,
    ref: string | undefined,
  ): Promise<WorkflowFileInfo> {
    assertWorkflowPath(path);
    const encodedPath = path.split("/").map(segment).join("/");
    const result = await this.requestJson(
      `/repos/${segment(owner)}/${segment(repo)}/contents/${encodedPath}`,
      ref === undefined ? undefined : { ref },
      { context: "contents" },
    );
    const raw = parseOrThrow(rawContentFileSchema, result.data);
    // Defence in depth: never return a different path or a non-file object, even
    // if a proxy or an unusual API response tries to redirect the content lookup.
    if (raw.type !== undefined && raw.type !== "file") {
      throw new TriageError(
        "UPSTREAM",
        "GitHub returned a non-file object for the workflow path.",
        { hint: HINTS.upstream },
      );
    }
    if (raw.path !== path) {
      throw new TriageError(
        "UPSTREAM",
        "GitHub returned content for a different path; refusing to use it.",
        { hint: HINTS.upstream },
      );
    }
    return {
      path: raw.path,
      sha: raw.sha,
      sizeBytes: raw.size,
      htmlUrl: safeHttpUrl(raw.html_url),
      contentBase64: raw.content,
      encoding: raw.encoding,
    };
  }

  async getRateLimit(): Promise<RateLimitInfo> {
    const result = await this.requestJson("/rate_limit");
    const raw = parseOrThrow(rawRateLimitSchema, result.data);
    const core = raw.resources?.core;
    if (core === undefined) {
      throw new TriageError("UPSTREAM", "GitHub did not return a core rate-limit resource.", {
        hint: HINTS.upstream,
      });
    }
    return {
      resource: "core",
      limit: core.limit,
      used: core.used,
      remaining: core.remaining,
      resetAt: new Date(core.reset * 1_000).toISOString(),
    };
  }

  async checkContentsAccess(owner: string, repo: string): Promise<ContentsAccess> {
    try {
      await this.requestJson(
        `/repos/${segment(owner)}/${segment(repo)}/contents/.github/workflows`,
        { per_page: 1 },
        { context: "contents" },
      );
      return {
        readable: true,
        status: "readable",
        detail: "The token can list workflow files in .github/workflows.",
      };
    } catch (error) {
      if (error instanceof TriageError && error.code === "FORBIDDEN") {
        return {
          readable: false,
          status: "forbidden",
          detail:
            "Contents: read is missing or blocked. Workflow-file metadata will be unavailable, but Actions data may still be readable.",
        };
      }
      if (error instanceof TriageError && error.code === "NOT_FOUND") {
        return {
          readable: false,
          status: "not_found",
          detail:
            "The .github/workflows directory was not found, or the token cannot see it (404 is used for both).",
        };
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Request plumbing (GET only)
  // ---------------------------------------------------------------------------

  private buildUrl(path: string, query?: Record<string, QueryValue>): URL {
    const url = new URL(`${this.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async requestJson(
    path: string,
    query?: Record<string, QueryValue>,
    options: { context?: "api" | "contents" } = {},
  ): Promise<JsonResult> {
    const url = this.buildUrl(path, query);
    const context = options.context ?? "api";
    let attempt = 0;

    for (;;) {
      try {
        const fetched = await this.fetchFollowingRedirects(url, {
          authenticated: true,
          accept: "application/vnd.github+json",
        });
        if (!fetched.response.ok) {
          await discardResponseBody(fetched.response);
          throw this.mapResponseError(fetched.response, fetched.meta, context);
        }

        const declaredLength = Number.parseInt(
          fetched.response.headers.get("content-length") ?? "",
          10,
        );
        if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
          await discardResponseBody(fetched.response);
          throw new TriageError(
            "RESPONSE_TOO_LARGE",
            "GitHub announced a JSON response larger than the server's safety limit.",
            { hint: HINTS.responseTooLarge, status: fetched.response.status },
          );
        }

        const body = await readResponseTextCapped(fetched.response, MAX_JSON_BYTES);
        if (body.truncated) {
          throw new TriageError(
            "RESPONSE_TOO_LARGE",
            "GitHub returned a JSON response larger than the server's safety limit.",
            { hint: HINTS.responseTooLarge, status: fetched.response.status },
          );
        }

        let data: unknown;
        try {
          data = JSON.parse(body.text) as unknown;
        } catch {
          throw new TriageError("UPSTREAM", "GitHub returned a response that was not valid JSON.", {
            hint: HINTS.upstream,
            status: fetched.response.status,
          });
        }
        return { data, meta: fetched.meta };
      } catch (error) {
        if (attempt === 0 && isRetryable(error)) {
          attempt += 1;
          await delay(this.retryDelayMs);
          continue;
        }
        throw error;
      }
    }
  }

  private headers(authenticated: boolean, accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      "User-Agent": USER_AGENT,
    };
    if (authenticated) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  /**
   * Follow a small number of redirects. Authorization is only attached to the
   * configured API origin, never to signed log-storage URLs or other hosts.
   */
  private async fetchFollowingRedirects(
    initialUrl: URL,
    options: { authenticated: boolean; accept: string },
  ): Promise<FetchedResponse> {
    const deadline = Date.now() + this.timeoutMs;
    let current = initialUrl;
    let authenticated = options.authenticated;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new TriageError("TIMEOUT", "The GitHub request exceeded its time limit.", {
          hint: HINTS.timeout,
        });
      }

      const startedAt = Date.now();
      let response: Response;
      try {
        response = await this.fetchImpl(current, {
          method: "GET",
          headers: this.headers(authenticated, options.accept),
          redirect: "manual",
          signal: AbortSignal.timeout(Math.max(1, remainingMs)),
        });
      } catch (error) {
        if (isTimeoutError(error)) {
          throw new TriageError("TIMEOUT", "The GitHub request timed out.", {
            hint: HINTS.timeout,
            cause: error,
          });
        }
        throw new TriageError("NETWORK", "Could not reach the GitHub API.", {
          hint: HINTS.network,
          cause: error,
        });
      }

      this.logger.debug("github_request", {
        path: current.pathname,
        status: response.status,
        ms: Date.now() - startedAt,
        authenticated,
      });

      const meta: ResponseMeta = {
        scopes: parseScopes(response.headers),
        rateLimit: parseRateLimit(response.headers),
        requestId: response.headers.get("x-github-request-id"),
      };

      if (!REDIRECT_STATUSES.has(response.status)) {
        return { response, meta };
      }

      const location = response.headers.get("location");
      if (location === null) {
        await discardResponseBody(response);
        throw new TriageError("UPSTREAM", "GitHub returned a redirect without a target.", {
          hint: HINTS.upstream,
          status: response.status,
          requestId: meta.requestId ?? undefined,
        });
      }
      if (hop === MAX_REDIRECTS) {
        await discardResponseBody(response);
        throw new TriageError("UPSTREAM", "GitHub returned too many redirects.", {
          hint: HINTS.upstream,
          status: response.status,
        });
      }

      await discardResponseBody(response);

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new TriageError("UPSTREAM", "GitHub returned an invalid redirect target.", {
          hint: HINTS.upstream,
        });
      }

      if (next.username !== "" || next.password !== "") {
        throw new TriageError("NETWORK", "Refusing a redirect that embeds credentials.", {
          hint: HINTS.network,
        });
      }
      if (
        next.protocol !== "https:" &&
        !(next.protocol === "http:" && isLoopbackHost(next.hostname))
      ) {
        throw new TriageError("NETWORK", "Refusing a redirect to a non-HTTPS destination.", {
          hint: "GitHub API and log downloads are expected to use HTTPS. Check GITHUB_API_BASE_URL.",
        });
      }

      authenticated = authenticated && next.origin === this.apiOrigin;
      current = next;
    }

    throw new TriageError("UPSTREAM", "GitHub returned too many redirects.", {
      hint: HINTS.upstream,
    });
  }

  private mapResponseError(
    response: Response,
    meta: ResponseMeta,
    context: "api" | "contents" | "logs",
  ): TriageError {
    const status = response.status;
    const requestId = meta.requestId ?? undefined;
    const rateLimit = meta.rateLimit;
    const retryAfterSeconds = parseRetryAfterSeconds(response.headers, meta.rateLimit);
    const rateLimited =
      status === 429 ||
      (status === 403 && (rateLimit?.remaining === 0 || retryAfterSeconds !== undefined));

    if (rateLimited) {
      return new TriageError("RATE_LIMITED", "GitHub API rate limit or secondary limit reached.", {
        hint: HINTS.rateLimited,
        status,
        requestId,
        retryAfterSeconds,
      });
    }
    if (status === 401) {
      return new TriageError("AUTH_INVALID", "GitHub rejected the configured token.", {
        hint: HINTS.authInvalid,
        status,
        requestId,
      });
    }
    if (status === 403) {
      return new TriageError(
        "FORBIDDEN",
        context === "contents"
          ? "The token cannot read repository contents."
          : "The token is not permitted to read this Actions data.",
        { hint: HINTS.forbidden, status, requestId },
      );
    }
    if (status === 404) {
      if (context === "logs") {
        return new TriageError("LOG_UNAVAILABLE", "The job log is not available.", {
          hint: HINTS.logUnavailable,
          status,
          requestId,
        });
      }
      return new TriageError(
        "NOT_FOUND",
        context === "contents"
          ? "The workflow file or repository was not found."
          : "The repository, run, or job was not found.",
        { hint: HINTS.notFound, status, requestId },
      );
    }
    if (status === 410) {
      return new TriageError("LOG_UNAVAILABLE", "The job log has expired.", {
        hint: HINTS.logUnavailable,
        status,
        requestId,
      });
    }
    if (status === 422) {
      return new TriageError("INVALID_INPUT", "GitHub rejected the request parameters.", {
        hint: "Check the owner, repository, date range, and pagination values. GitHub validation details are intentionally not echoed.",
        status,
        requestId,
      });
    }
    if (status === 451) {
      return new TriageError("FORBIDDEN", "GitHub reports this repository as unavailable.", {
        hint: "The repository may be blocked for legal reasons or unavailable to this token.",
        status,
        requestId,
      });
    }
    return new TriageError("UPSTREAM", `GitHub returned an unexpected HTTP ${status} response.`, {
      hint: HINTS.upstream,
      status,
      requestId,
    });
  }
}

/**
 * Lazy wrapper so the MCP server can start and register tools even when
 * GITHUB_TOKEN is missing. Tool calls then return AUTH_MISSING guidance instead
 * of the process crashing during startup.
 */
export function createLazyGitHubReader(config: AppConfig, logger: Logger): GitHubReader {
  let instance: GitHubClient | null = null;
  const get = (): GitHubClient => {
    instance ??= new GitHubClient(config, { logger });
    return instance;
  };

  return {
    getRepository: (owner, repo) => get().getRepository(owner, repo),
    getAuthenticatedUser: () => get().getAuthenticatedUser(),
    listWorkflowRuns: (params) => get().listWorkflowRuns(params),
    getWorkflowRun: (owner, repo, runId) => get().getWorkflowRun(owner, repo, runId),
    listJobsForRun: (owner, repo, runId, options) =>
      get().listJobsForRun(owner, repo, runId, options),
    getJob: (owner, repo, jobId) => get().getJob(owner, repo, jobId),
    getJobLog: (owner, repo, jobId) => get().getJobLog(owner, repo, jobId),
    getWorkflow: (owner, repo, workflowId) => get().getWorkflow(owner, repo, workflowId),
    getWorkflowFile: (owner, repo, path, ref) => get().getWorkflowFile(owner, repo, path, ref),
    getRateLimit: () => get().getRateLimit(),
    checkContentsAccess: (owner, repo) => get().checkContentsAccess(owner, repo),
  };
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function buildCreatedFilter(after?: string, before?: string): string | undefined {
  if (after !== undefined && before !== undefined) return `${after}..${before}`;
  if (after !== undefined) return `>=${after}`;
  if (before !== undefined) return `<=${before}`;
  return undefined;
}

function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new TriageError("UPSTREAM", "GitHub returned a response with an unexpected shape.", {
      hint: HINTS.upstream,
    });
  }
  return result.data;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function isRetryable(error: unknown): boolean {
  if (!(error instanceof TriageError)) return false;
  return error.code === "NETWORK" || (error.code === "UPSTREAM" && (error.status ?? 0) >= 500);
}

function parseRetryAfterSeconds(
  headers: Headers,
  rateLimit: RateLimitInfo | null,
): number | undefined {
  const raw = headers.get("retry-after");
  if (raw !== null) {
    const seconds = Number.parseInt(raw, 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
    const date = Date.parse(raw);
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1_000));
  }
  if (rateLimit?.resetAt) {
    const reset = Date.parse(rateLimit.resetAt);
    if (!Number.isNaN(reset)) return Math.max(0, Math.ceil((reset - Date.now()) / 1_000));
  }
  return undefined;
}
