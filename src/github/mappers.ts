import { durationSeconds, shortSha } from "../util/text.js";
import type {
  JobSummary,
  RateLimitInfo,
  RepositoryInfo,
  StepSummary,
  WorkflowInfo,
  WorkflowRunSummary,
} from "./types.js";
import type {
  RawJob,
  RawStep,
  RawWorkflowRun,
  rawRepositorySchema,
  rawWorkflowSchema,
} from "./schemas.js";
import type { z } from "zod";

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

export function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function mapWorkflowRun(raw: RawWorkflowRun): WorkflowRunSummary {
  return {
    id: raw.id,
    name: raw.name ?? "(unnamed workflow)",
    displayTitle: raw.display_title,
    workflowId: raw.workflow_id,
    path: raw.path,
    runNumber: raw.run_number,
    attempt: raw.run_attempt ?? 1,
    event: raw.event,
    status: raw.status,
    conclusion: raw.conclusion,
    branch: raw.head_branch,
    headSha: raw.head_sha,
    headShaShort: shortSha(raw.head_sha),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    startedAt: raw.run_started_at,
    url: safeHttpUrl(raw.html_url),
    actor: raw.actor?.login ?? null,
  };
}

export function mapStep(raw: RawStep): StepSummary {
  return {
    number: raw.number,
    name: raw.name,
    status: raw.status,
    conclusion: raw.conclusion,
    startedAt: raw.started_at,
    completedAt: raw.completed_at,
  };
}

export function mapJob(raw: RawJob): JobSummary {
  const steps = raw.steps.map(mapStep);
  return {
    id: raw.id,
    runId: raw.run_id,
    runAttempt: raw.run_attempt,
    name: raw.name,
    status: raw.status,
    conclusion: raw.conclusion,
    startedAt: raw.started_at,
    completedAt: raw.completed_at,
    durationSeconds: durationSeconds(raw.started_at, raw.completed_at),
    url: safeHttpUrl(raw.html_url),
    stepsCount: steps.length,
    failedSteps: steps.filter(
      (step) => step.conclusion !== null && FAILED_CONCLUSIONS.has(step.conclusion),
    ),
  };
}

export function isFailedJob(job: JobSummary): boolean {
  return job.conclusion !== null && FAILED_CONCLUSIONS.has(job.conclusion);
}

export function mapRepository(raw: z.infer<typeof rawRepositorySchema>): RepositoryInfo {
  return {
    id: raw.id,
    fullName: raw.full_name,
    private: raw.private,
    defaultBranch: raw.default_branch,
    archived: raw.archived,
    disabled: raw.disabled,
    url: safeHttpUrl(raw.html_url),
    permissions: raw.permissions,
  };
}

export function mapWorkflow(raw: z.infer<typeof rawWorkflowSchema>): WorkflowInfo {
  return {
    id: raw.id,
    name: raw.name,
    path: raw.path,
    state: raw.state,
    url: safeHttpUrl(raw.html_url),
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function parseRateLimit(headers: Headers): RateLimitInfo | null {
  const limit = parseNonNegativeInt(headers.get("x-ratelimit-limit"));
  const remaining = parseNonNegativeInt(headers.get("x-ratelimit-remaining"));
  const used = parseNonNegativeInt(headers.get("x-ratelimit-used"));
  const reset = parseNonNegativeInt(headers.get("x-ratelimit-reset"));
  if (limit === null || remaining === null) return null;
  return {
    resource: headers.get("x-ratelimit-resource") ?? "core",
    limit,
    remaining,
    used: used ?? Math.max(0, limit - remaining),
    resetAt: reset === null ? null : new Date(reset * 1_000).toISOString(),
  };
}

export function parseScopes(headers: Headers): string[] {
  const raw = headers.get("x-oauth-scopes");
  if (!raw) return [];
  return raw
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}

function parseNonNegativeInt(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
