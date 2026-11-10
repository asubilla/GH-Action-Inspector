import { z } from "zod";
import {
  HARD_MAX_LOG_EXCERPT_CHARS,
  MAX_WORKFLOW_FILE_CHARS,
  MIN_LOG_EXCERPT_CHARS,
  type AppConfig,
} from "../config.js";
import { HINTS, TriageError } from "../errors.js";
import { isWorkflowPath } from "../github/workflow-path.js";

export const ownerField = z
  .string()
  .trim()
  .min(1)
  .max(39)
  .regex(
    /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/,
    "owner must be a GitHub user or organization name",
  )
  .describe("Repository owner (user or organization), for example octocat.");

export const repoField = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "repo may contain letters, digits, dot, underscore, and hyphen")
  .refine((value) => value !== "." && value !== "..", "repo must not be . or ..")
  .describe("Repository name without the owner, for example hello-world.");

export const runIdField = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe("Workflow run ID from a run URL, for example 1234567890.");

export const jobIdField = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .describe("Job ID from a job URL or get/list job output.");

export const branchField = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    // eslint-disable-next-line no-control-regex -- reject control characters in refs
    (value) => !/[\u0000-\u001f\u007f]/.test(value),
    "branch must not contain control characters",
  )
  .refine((value) => !/\s/.test(value), "branch must not contain whitespace")
  .refine((value) => !value.startsWith("-"), "branch must not start with -")
  .refine(
    (value) => !value.startsWith("/") && !value.endsWith("/"),
    "branch must not start or end with /",
  )
  .refine((value) => !value.includes("//"), "branch must not contain //")
  .refine((value) => !value.includes(".."), "branch must not contain ..")
  .refine((value) => !value.includes("@{"), "branch must not contain @{")
  .refine((value) => !value.endsWith(".lock"), "branch must not end with .lock")
  .refine((value) => !value.endsWith("."), "branch must not end with .")
  .describe("Branch name, for example main or feature/login.");

export const refField = branchField.describe(
  "Git ref (branch, tag, or commit SHA) used to read a workflow file. Defaults to the run's commit, workflow's default branch context, or the repository default branch.",
);

export const RUN_STATUSES = [
  "queued",
  "in_progress",
  "completed",
  "requested",
  "waiting",
  "pending",
] as const;

export const RUN_CONCLUSIONS = [
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "stale",
  "startup_failure",
] as const;

export const RUN_STATUS_FILTERS = [...RUN_STATUSES, ...RUN_CONCLUSIONS] as const;

export const statusField = z
  .enum(RUN_STATUS_FILTERS)
  .optional()
  .describe(
    "Optional status or conclusion filter, for example completed, failure, success, cancelled, or timed_out. GitHub accepts both run statuses and conclusions here.",
  );

export const eventField = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "event must be a lowercase GitHub Actions event name")
  .optional()
  .describe(
    "Optional triggering event, for example push, pull_request, schedule, or workflow_dispatch.",
  );

export function dateTimeField(label: string) {
  return z
    .string()
    .trim()
    .min(4)
    .max(64)
    .refine(
      (value) => !Number.isNaN(Date.parse(value)),
      "must be a valid ISO 8601 date or date-time",
    )
    .transform((value) => new Date(value).toISOString())
    .optional()
    .describe(`${label} (ISO 8601, for example 2026-01-31 or 2026-01-31T12:00:00Z).`);
}

export const limitField = z
  .number()
  .int()
  .min(1)
  .max(100)
  .default(20)
  .describe(
    "Maximum number of runs to return (1-100). Defaults to 20; GitHub page size is capped at 100.",
  );

export const pageField = z
  .number()
  .int()
  .min(1)
  .max(10)
  .default(1)
  .describe("1-based page of GitHub results to request (1-10).");

export function logCharsField(config: AppConfig, max = HARD_MAX_LOG_EXCERPT_CHARS) {
  return z
    .number()
    .int()
    .min(MIN_LOG_EXCERPT_CHARS)
    .max(max)
    .optional()
    .describe(
      `Maximum characters of log excerpt text to return. Defaults to ${config.logExcerptChars}; hard server cap is ${max}.`,
    );
}

export const contextLinesField = z
  .number()
  .int()
  .min(0)
  .max(8)
  .default(3)
  .describe("Lines of context around each matched failure marker (0-8).");

export const maxExcerptsField = z
  .number()
  .int()
  .min(1)
  .max(10)
  .default(4)
  .describe("Maximum number of excerpt regions to return (1-10).");

export const maxJobsField = z
  .number()
  .int()
  .min(1)
  .max(10)
  .default(5)
  .describe("Maximum number of failed jobs to analyze (1-10). Keeps the report focused.");

export const lookbackField = z
  .number()
  .int()
  .min(1)
  .max(50)
  .default(20)
  .describe("How many recent successful runs of the same workflow and branch to search (1-50).");

export const workflowPathField = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(isWorkflowPath, "must be a .github/workflows/*.yml or *.yaml path")
  .optional()
  .describe(
    "Workflow file path, for example .github/workflows/ci.yml. Only workflow files are readable.",
  );

export const workflowIdField = z.coerce
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .optional()
  .describe("Workflow ID from a run or workflow URL.");

export function includeContentField() {
  return z
    .boolean()
    .default(false)
    .describe(
      "Set true to include redacted, size-limited workflow file content. Metadata is returned even when false.",
    );
}

export function workflowFileCharsField() {
  return z
    .number()
    .int()
    .min(MIN_LOG_EXCERPT_CHARS)
    .max(MAX_WORKFLOW_FILE_CHARS)
    .optional()
    .describe(
      `Maximum workflow-file characters to return. Defaults to 8000; hard server cap is ${MAX_WORKFLOW_FILE_CHARS}.`,
    );
}

export function validateDateRange(after?: string, before?: string): void {
  if (after === undefined || before === undefined) return;
  if (Date.parse(after) > Date.parse(before)) {
    throw new TriageError(
      "INVALID_INPUT",
      "createdAfter must be earlier than or equal to createdBefore.",
      { hint: HINTS.invalidInput },
    );
  }
}

export function resolveLogChars(config: AppConfig, requested?: number): number {
  return Math.min(
    HARD_MAX_LOG_EXCERPT_CHARS,
    Math.max(MIN_LOG_EXCERPT_CHARS, Math.trunc(requested ?? config.logExcerptChars)),
  );
}

export function resolveWorkflowFileChars(requested?: number): number {
  return Math.min(
    MAX_WORKFLOW_FILE_CHARS,
    Math.max(MIN_LOG_EXCERPT_CHARS, Math.trunc(requested ?? 8_000)),
  );
}
