import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config.js";
import { TriageError } from "../src/errors.js";
import { GitHubClient } from "../src/github/client.js";
import { createLogger } from "../src/logger.js";

interface FetchCall {
  url: URL;
  init: RequestInit;
}

const silentSink = { write: (): boolean => true };

function makeClient(
  handler: (url: URL, init: RequestInit, callNumber: number) => Response | Promise<Response>,
): { client: GitHubClient; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const raw =
      input instanceof URL ? input.toString() : typeof input === "string" ? input : input.url;
    const url = new URL(raw);
    const requestInit = init ?? {};
    calls.push({ url, init: requestInit });
    return handler(url, requestInit, calls.length);
  }) as typeof fetch;

  const config = buildConfig({
    githubToken: "synthetic-token-for-tests",
    requestTimeoutMs: 5_000,
  });
  return {
    client: new GitHubClient(config, {
      fetchImpl,
      retryDelayMs: 0,
      logger: createLogger(false, silentSink),
    }),
    calls,
  };
}

function jsonResponse(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...options.headers },
  });
}

function runBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1001,
    name: "CI",
    display_title: "Fix test",
    workflow_id: 77,
    path: ".github/workflows/ci.yml",
    run_number: 42,
    run_attempt: 1,
    event: "push",
    status: "completed",
    conclusion: "failure",
    head_branch: "main",
    head_sha: "abcdef1234567890abcdef1234567890abcdef12",
    created_at: "2026-01-10T10:00:00Z",
    updated_at: "2026-01-10T10:05:00Z",
    run_started_at: "2026-01-10T10:00:10Z",
    html_url: "https://github.com/example-org/example-repo/actions/runs/1001",
    actor: { login: "octocat" },
    ...overrides,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<TriageError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(TriageError);
    const triage = error as TriageError;
    expect(triage.code).toBe(code);
    return triage;
  }
  throw new Error(`Expected TriageError with code ${code}`);
}

describe("GitHub read client", () => {
  it("lists runs with explicit filters, GET only, and a bearer token", async () => {
    const { client, calls } = makeClient(() =>
      jsonResponse({ total_count: 1, workflow_runs: [runBody()] }),
    );

    const result = await client.listWorkflowRuns({
      owner: "example-org",
      repo: "example-repo",
      branch: "main",
      status: "failure",
      event: "push",
      createdAfter: "2026-01-01T00:00:00.000Z",
      createdBefore: "2026-01-31T00:00:00.000Z",
      limit: 20,
      page: 1,
    });

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.headShaShort).toBe("abcdef1");
    expect(result.totalCount).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/repos/example-org/example-repo/actions/runs");
    expect(calls[0]?.url.searchParams.get("per_page")).toBe("20");
    expect(calls[0]?.url.searchParams.get("status")).toBe("failure");
    expect(calls[0]?.url.searchParams.get("branch")).toBe("main");
    expect(calls[0]?.url.searchParams.get("created")).toBe(
      "2026-01-01T00:00:00.000Z..2026-01-31T00:00:00.000Z",
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer synthetic-token-for-tests");
  });

  it("uses the workflow-scoped runs endpoint when workflowId is provided", async () => {
    const { client, calls } = makeClient(() => jsonResponse({ total_count: 0, workflow_runs: [] }));
    await client.listWorkflowRuns({
      owner: "example-org",
      repo: "example-repo",
      workflowId: 77,
      limit: 5,
      page: 1,
    });
    expect(calls[0]?.url.pathname).toBe(
      "/repos/example-org/example-repo/actions/workflows/77/runs",
    );
  });

  it("maps job pagination and reports truncation", async () => {
    const makeJobs = (start: number, count: number) =>
      Array.from({ length: count }, (_value, index) => ({
        id: start + index,
        name: `job-${start + index}`,
        status: "completed",
        conclusion: "success",
        steps: [],
      }));

    const { client, calls } = makeClient((url) => {
      const page = Number(url.searchParams.get("page"));
      if (page === 1) {
        return jsonResponse({ total_count: 150, jobs: makeJobs(1, 100) });
      }
      return jsonResponse({ total_count: 150, jobs: makeJobs(101, 50) });
    });

    const result = await client.listJobsForRun("example-org", "example-repo", 1001);
    expect(result.jobs).toHaveLength(150);
    expect(result.truncated).toBe(false);
    expect(calls).toHaveLength(2);

    const truncating = makeClient(() => jsonResponse({ total_count: 400, jobs: makeJobs(1, 100) }));
    const truncated = await truncating.client.listJobsForRun("example-org", "example-repo", 1001);
    expect(truncated.jobs).toHaveLength(300);
    expect(truncated.truncated).toBe(true);
    expect(truncating.calls).toHaveLength(3);
  });

  it("never retries rate limits and reports reset metadata", async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const { client, calls } = makeClient(() =>
      jsonResponse(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": String(reset),
            "x-github-request-id": "REQ-123",
          },
        },
      ),
    );

    const error = await expectCode(
      client.listWorkflowRuns({ owner: "a", repo: "b", limit: 1, page: 1 }),
      "RATE_LIMITED",
    );
    expect(calls).toHaveLength(1);
    expect(error.requestId).toBe("REQ-123");
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.message).not.toContain("synthetic-token");
  });

  it("maps 401, plain 403, 404, and 429 responses", async () => {
    await expectCode(
      makeClient(() => jsonResponse({}, { status: 401 })).client.listWorkflowRuns({
        owner: "a",
        repo: "b",
        limit: 1,
        page: 1,
      }),
      "AUTH_INVALID",
    );
    await expectCode(
      makeClient(() => jsonResponse({}, { status: 403 })).client.getWorkflowRun("a", "b", 1),
      "FORBIDDEN",
    );
    await expectCode(
      makeClient(() => jsonResponse({}, { status: 404 })).client.getWorkflowRun("a", "b", 1),
      "NOT_FOUND",
    );
    const limited = makeClient(() =>
      jsonResponse(
        { message: "secondary rate limit" },
        { status: 429, headers: { "retry-after": "30" } },
      ),
    );
    const error = await expectCode(limited.client.getWorkflowRun("a", "b", 1), "RATE_LIMITED");
    expect(error.retryAfterSeconds).toBe(30);
    expect(limited.calls).toHaveLength(1);
  });

  it("retries transient 5xx once and then succeeds", async () => {
    const { client, calls } = makeClient((_url, _init, callNumber) => {
      if (callNumber === 1) return jsonResponse({}, { status: 502 });
      return jsonResponse(runBody());
    });
    const run = await client.getWorkflowRun("example-org", "example-repo", 1001);
    expect(run.id).toBe(1001);
    expect(calls).toHaveLength(2);
  });

  it("stops after one retry for persistent 5xx failures", async () => {
    const { client, calls } = makeClient(() => jsonResponse({}, { status: 503 }));
    await expectCode(client.getWorkflowRun("a", "b", 1), "UPSTREAM");
    expect(calls).toHaveLength(2);
  });

  it("maps timeouts without retrying", async () => {
    const { client, calls } = makeClient(() => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    });
    await expectCode(client.getWorkflowRun("a", "b", 1), "TIMEOUT");
    expect(calls).toHaveLength(1);
  });

  it("retries network failures once", async () => {
    const { client, calls } = makeClient(() => {
      throw new TypeError("fetch failed");
    });
    await expectCode(client.getWorkflowRun("a", "b", 1), "NETWORK");
    expect(calls).toHaveLength(2);
  });

  it("rejects oversized JSON before reading it", async () => {
    const { client } = makeClient(
      () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "999999999" },
        }),
    );
    await expectCode(client.getWorkflowRun("a", "b", 1), "RESPONSE_TOO_LARGE");
  });

  it("follows log redirects without forwarding authorization", async () => {
    const signedUrl = "https://objects.example.com/logs/5001?sig=synthetic-signature";
    const { client, calls } = makeClient((url) => {
      if (url.hostname === "api.github.com") {
        return new Response(null, { status: 302, headers: { location: signedUrl } });
      }
      return new Response("2026-01-10T10:00:00.0000000Z error: boom\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    });

    const log = await client.getJobLog("example-org", "example-repo", 5001);
    expect(log.text).toContain("error: boom");
    expect(calls).toHaveLength(2);
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBeDefined();
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(calls[1]?.url.toString()).toBe(signedUrl);
  });

  it("refuses insecure or credential-bearing redirects", async () => {
    const insecure = makeClient(
      () =>
        new Response(null, { status: 302, headers: { location: "http://evil.example.com/log" } }),
    );
    await expectCode(insecure.client.getJobLog("a", "b", 1), "NETWORK");

    const credentials = makeClient(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://user:pass@objects.example.com/log" },
        }),
    );
    await expectCode(credentials.client.getJobLog("a", "b", 1), "NETWORK");
  });

  it("maps missing logs to LOG_UNAVAILABLE", async () => {
    const { client } = makeClient(() => jsonResponse({ message: "Not Found" }, { status: 404 }));
    await expectCode(client.getJobLog("a", "b", 1), "LOG_UNAVAILABLE");
  });

  it("rejects non-workflow paths before making any request", async () => {
    const { client, calls } = makeClient(() => jsonResponse({}));
    await expectCode(
      client.getWorkflowFile("a", "b", "../.github/workflows/ci.yml", "main"),
      "INVALID_INPUT",
    );
    await expectCode(client.getWorkflowFile("a", "b", "src/index.ts", "main"), "INVALID_INPUT");
    expect(calls).toHaveLength(0);
  });

  it("reads workflow file metadata and content", async () => {
    const content = Buffer.from("name: CI\non: [push]\n", "utf8").toString("base64");
    const { client, calls } = makeClient(() =>
      jsonResponse({
        type: "file",
        path: ".github/workflows/ci.yml",
        sha: "abc123",
        size: 18,
        encoding: "base64",
        content,
        html_url: "https://github.com/example-org/example-repo/blob/main/.github/workflows/ci.yml",
      }),
    );

    const file = await client.getWorkflowFile(
      "example-org",
      "example-repo",
      ".github/workflows/ci.yml",
      "main",
    );
    expect(file.path).toBe(".github/workflows/ci.yml");
    expect(file.contentBase64).toBe(content);
    expect(calls[0]?.url.searchParams.get("ref")).toBe("main");
    expect(calls[0]?.url.pathname).toBe(
      "/repos/example-org/example-repo/contents/.github/workflows/ci.yml",
    );
  });

  it("refuses a workflow response for a different path or a non-file object", async () => {
    const wrongPath = makeClient(() =>
      jsonResponse({
        type: "file",
        path: "src/index.ts",
        sha: "abc",
        size: 10,
        encoding: "base64",
        content: "aGVsbG8=",
      }),
    );
    await expectCode(
      wrongPath.client.getWorkflowFile("a", "b", ".github/workflows/ci.yml", "main"),
      "UPSTREAM",
    );

    const directory = makeClient(() =>
      jsonResponse({
        type: "dir",
        path: ".github/workflows/ci.yml",
        sha: "abc",
        size: 0,
        encoding: "base64",
        content: "",
      }),
    );
    await expectCode(
      directory.client.getWorkflowFile("a", "b", ".github/workflows/ci.yml", "main"),
      "UPSTREAM",
    );
  });

  it("reports contents permission status instead of failing the whole check", async () => {
    const forbidden = makeClient(() => jsonResponse({}, { status: 403 }));
    const access = await forbidden.client.checkContentsAccess("a", "b");
    expect(access.status).toBe("forbidden");
    expect(access.readable).toBe(false);

    const missing = makeClient(() => jsonResponse({}, { status: 404 }));
    const notFound = await missing.client.checkContentsAccess("a", "b");
    expect(notFound.status).toBe("not_found");
  });

  it("reads rate limit data", async () => {
    const { client } = makeClient(() =>
      jsonResponse({
        resources: {
          core: { limit: 5000, used: 20, remaining: 4980, reset: 1_800_000_000 },
        },
      }),
    );
    const rate = await client.getRateLimit();
    expect(rate.remaining).toBe(4980);
    expect(rate.resetAt).toBe(new Date(1_800_000_000_000).toISOString());
  });
});
