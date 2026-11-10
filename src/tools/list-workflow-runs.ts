import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY_ANNOTATIONS, READ_ONLY_PREFIX } from "./annotations.js";
import type { ToolContext } from "./context.js";
import { runTool } from "./respond.js";
import {
  branchField,
  dateTimeField,
  eventField,
  limitField,
  ownerField,
  pageField,
  repoField,
  statusField,
  validateDateRange,
} from "./schemas.js";

export const listWorkflowRunsSchema = {
  owner: ownerField,
  repo: repoField,
  branch: branchField.optional().describe("Optional branch filter."),
  status: statusField,
  event: eventField,
  createdAfter: dateTimeField("Only include runs created at or after this time"),
  createdBefore: dateTimeField("Only include runs created at or before this time"),
  limit: limitField,
  page: pageField,
};

export async function listWorkflowRuns(
  ctx: ToolContext,
  input: {
    owner: string;
    repo: string;
    branch?: string | undefined;
    status?: string | undefined;
    event?: string | undefined;
    createdAfter?: string | undefined;
    createdBefore?: string | undefined;
    limit: number;
    page: number;
  },
): Promise<unknown> {
  validateDateRange(input.createdAfter, input.createdBefore);
  const result = await ctx.client.listWorkflowRuns({
    owner: input.owner,
    repo: input.repo,
    branch: input.branch,
    status: input.status,
    event: input.event,
    createdAfter: input.createdAfter,
    createdBefore: input.createdBefore,
    limit: input.limit,
    page: input.page,
  });

  const notes: string[] = [];
  if (result.totalCount > result.runs.length) {
    notes.push(
      `GitHub reports ${result.totalCount} matching run(s); this page returned ${result.runs.length}. Use page or a narrower filter to see more.`,
    );
  }
  if (input.branch === undefined && input.status === undefined) {
    notes.push(
      'No branch or status filter was applied. Add status="failure" (with conclusion="failure" when needed) and a branch to focus on a failure.',
    );
  }

  return {
    summary: `Returned ${result.runs.length} workflow run(s), newest first${input.status ? ` with status ${input.status}` : ""}.`,
    query: {
      owner: input.owner,
      repo: input.repo,
      branch: input.branch ?? null,
      status: input.status ?? null,
      event: input.event ?? null,
      createdAfter: input.createdAfter ?? null,
      createdBefore: input.createdBefore ?? null,
      limit: input.limit,
      page: input.page,
    },
    totalCount: result.totalCount,
    returned: result.runs.length,
    runs: result.runs,
    rateLimit: result.meta.rateLimit,
    notes,
  };
}

export function registerListWorkflowRuns(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "list_workflow_runs",
    {
      title: "List workflow runs",
      description:
        READ_ONLY_PREFIX +
        "List recent GitHub Actions workflow runs for a repository with explicit branch, status, event, date-range, page, and limit filters. Returns IDs, workflow names, branch, commit SHA, status, conclusion, timestamps, and URLs. Page size is capped at 100.",
      inputSchema: listWorkflowRunsSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (input) => runTool(ctx, "list_workflow_runs", () => listWorkflowRuns(ctx, input)),
  );
}
