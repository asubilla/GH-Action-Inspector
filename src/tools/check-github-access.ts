import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HINTS, toSafeError, type SafeError } from "../errors.js";
import type { RateLimitInfo } from "../github/types.js";
import { READ_ONLY_ANNOTATIONS, READ_ONLY_PREFIX } from "./annotations.js";
import type { ToolContext } from "./context.js";
import { runTool } from "./respond.js";
import { ownerField, repoField } from "./schemas.js";

export const checkGithubAccessSchema = {
  owner: ownerField,
  repo: repoField,
  checkContents: z
    .boolean()
    .default(false)
    .describe("Also test Contents: read access needed by get_workflow_file_metadata."),
};

interface CheckEntry {
  ok: boolean | null;
  detail?: string;
  code?: string;
  error?: SafeError;
  [key: string]: unknown;
}

export async function checkGitHubAccess(
  ctx: ToolContext,
  input: { owner: string; repo: string; checkContents: boolean },
): Promise<unknown> {
  const tokenConfigured = ctx.config.githubToken !== undefined;
  const guidance: string[] = [];
  const checks: {
    userRead: CheckEntry;
    repositoryRead: CheckEntry;
    actionsRead: CheckEntry;
    contentsRead: CheckEntry;
    rateLimit: CheckEntry;
  } = {
    userRead: { ok: null },
    repositoryRead: { ok: null },
    actionsRead: { ok: null },
    contentsRead: { ok: null, detail: "Not checked." },
    rateLimit: { ok: null },
  };
  let repository: Record<string, unknown> | null = null;
  let scopes: string[] = [];
  let rateLimit: RateLimitInfo | null = null;

  const userResult = await safeCall(() => ctx.client.getAuthenticatedUser());
  checks.userRead = userResult.ok
    ? { ok: true, login: userResult.value.login }
    : { ok: false, error: userResult.error };

  const repoResult = await safeCall(() => ctx.client.getRepository(input.owner, input.repo));
  if (repoResult.ok) {
    repository = {
      fullName: repoResult.value.repository.fullName,
      private: repoResult.value.repository.private,
      defaultBranch: repoResult.value.repository.defaultBranch,
      archived: repoResult.value.repository.archived,
      disabled: repoResult.value.repository.disabled,
      url: repoResult.value.repository.url,
      permissions: repoResult.value.repository.permissions,
    };
    scopes = repoResult.value.meta.scopes;
    rateLimit = repoResult.value.meta.rateLimit;
    checks.repositoryRead = { ok: true };
  } else {
    checks.repositoryRead = { ok: false, error: repoResult.error };
    guidance.push(...guidanceForError(repoResult.error));
  }

  if (repoResult.ok) {
    const actionsResult = await safeCall(() =>
      ctx.client.listWorkflowRuns({
        owner: input.owner,
        repo: input.repo,
        limit: 1,
        page: 1,
      }),
    );
    checks.actionsRead = actionsResult.ok
      ? { ok: true, matchingRunsVisible: actionsResult.value.totalCount }
      : { ok: false, error: actionsResult.error };
    if (!actionsResult.ok) {
      guidance.push(
        "Actions: read is required to list runs, jobs, and logs. Add it to the fine-grained token and ensure repository administrators allow the token.",
      );
      if (actionsResult.error.code === "FORBIDDEN") guidance.push(HINTS.forbidden);
    }
  } else {
    checks.actionsRead = {
      ok: null,
      detail: "Skipped because the repository was not readable.",
    };
  }

  if (input.checkContents) {
    const contentsResult = await safeCall(() =>
      ctx.client.checkContentsAccess(input.owner, input.repo),
    );
    checks.contentsRead = contentsResult.ok
      ? {
          ok: contentsResult.value.readable,
          status: contentsResult.value.status,
          detail: contentsResult.value.detail,
        }
      : { ok: false, error: contentsResult.error };
    if (contentsResult.ok && !contentsResult.value.readable) {
      guidance.push(
        "Contents: read is required only for get_workflow_file_metadata. Add it if you need workflow file content; it is not needed for run/job/log triage.",
      );
    }
  }

  const rateResult = await safeCall(() => ctx.client.getRateLimit());
  if (rateResult.ok) {
    rateLimit = rateResult.value;
    checks.rateLimit = { ok: true };
  } else {
    checks.rateLimit = { ok: false, error: rateResult.error };
  }

  const ok = tokenConfigured && repoResult.ok && checks.actionsRead.ok === true;

  if (!tokenConfigured) {
    guidance.unshift(HINTS.authMissing);
  } else if (ok) {
    guidance.push(
      'Access looks sufficient for read-only Actions triage. Try list_workflow_runs with status="failure" to find a run, then analyze_workflow_failure.',
    );
  }

  const tokenKind = scopes.length > 0 ? "classic-personal-access-token" : "fine-grained-or-app";

  return {
    summary: tokenConfigured
      ? ok
        ? `Token can read repository and Actions data for ${input.owner}/${input.repo}.`
        : `Access check found missing permissions for ${input.owner}/${input.repo}; see guidance.`
      : "GITHUB_TOKEN is not configured; see guidance.",
    ok,
    readOnly: true,
    token: {
      configured: tokenConfigured,
      kind: tokenConfigured ? tokenKind : "missing",
      scopes: scopes.length > 0 ? scopes : null,
      note:
        scopes.length > 0
          ? "Scopes are reported by the GitHub API for classic tokens only."
          : "Fine-grained tokens and GitHub Apps do not expose OAuth scopes; permissions are checked by API access instead.",
    },
    apiBaseUrl: ctx.config.apiBaseUrl,
    repository,
    checks,
    rateLimit,
    guidance: [...new Set(guidance)],
    notes: [
      "The token value is never returned, logged, or accepted as a tool argument.",
      "No write permission is needed or recommended. Use a read-only fine-grained token limited to this repository.",
      "For private repositories, the token owner must have access and the fine-grained token must be approved for the organization if required.",
    ],
  };
}

type SafeCallResult<T> = { ok: true; value: T } | { ok: false; error: SafeError };

async function safeCall<T>(call: () => Promise<T>): Promise<SafeCallResult<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, error: toSafeError(error) };
  }
}

function guidanceForError(error: SafeError): string[] {
  switch (error.code) {
    case "AUTH_MISSING":
      return [HINTS.authMissing];
    case "AUTH_INVALID":
      return [HINTS.authInvalid];
    case "FORBIDDEN":
      return [HINTS.forbidden];
    case "NOT_FOUND":
      return [
        HINTS.notFound,
        "If the repository is private, confirm the token owner can access it and that the fine-grained token is scoped to it.",
      ];
    case "RATE_LIMITED":
      return [HINTS.rateLimited];
    case "TIMEOUT":
    case "NETWORK":
      return [HINTS.network];
    default:
      return [error.hint];
  }
}

export function registerCheckGitHubAccess(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "check_github_access",
    {
      title: "Check GitHub access",
      description:
        READ_ONLY_PREFIX +
        "Verify that the configured token can see the repository and read Actions data, optionally check Contents: read, and return rate-limit state plus actionable permission guidance. The token value is never returned.",
      inputSchema: checkGithubAccessSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => runTool(ctx, "check_github_access", () => checkGitHubAccess(ctx, input)),
  );
}
