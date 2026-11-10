import type { SafeError } from "../errors.js";
import { REDACTION_DISCLAIMER } from "../log/redact.js";
import type { LogExcerptResult } from "../log/excerpts.js";
import type { JobSummary, WorkflowRunSummary } from "../github/types.js";
import { uniqueStrings } from "../util/text.js";
import { classifyFailure, type Classification, type ClassificationLine } from "./classify.js";
import { GENERAL_NEXT_STEPS, NEXT_STEPS } from "./categories.js";

export interface JobLogEvidence {
  job: JobSummary;
  excerpts: LogExcerptResult | null;
  error: SafeError | null;
}

export interface BuildTriageInput {
  run: WorkflowRunSummary;
  failedJobs: readonly JobSummary[];
  logEvidence: readonly JobLogEvidence[];
  jobsScanned: number;
  totalJobs: number;
  /** Total failed jobs on the run, which may exceed the analyzed `failedJobs` slice. */
  totalFailedJobs?: number;
  jobsTruncated: boolean;
  includeLogs: boolean;
  maxJobs: number;
  maxCharsPerJob: number;
}

export interface TriageReport {
  summary: string;
  applicable: true;
  run: {
    id: number;
    name: string;
    runNumber: number | null;
    attempt: number;
    branch: string | null;
    headSha: string | null;
    event: string;
    status: string | null;
    conclusion: string | null;
    createdAt: string | null;
    url: string | null;
  };
  failure: Classification;
  evidence: Array<{
    job: string;
    step: string | null;
    lineNumber: number | null;
    marker: string;
    text: string;
  }>;
  affectedJobs: Array<{
    id: number;
    name: string;
    conclusion: string | null;
    url: string | null;
    failedSteps: Array<{ name: string; conclusion: string | null }>;
  }>;
  logStatus: Array<{
    job: string;
    available: boolean;
    excerptCount: number;
    totalLines: number | null;
    truncated: boolean;
    redactionCount: number;
    notes: string[];
    error: SafeError | null;
  }>;
  observed: string[];
  inference: string[];
  uncertainties: string[];
  nextSteps: string[];
  limits: {
    maxJobs: number;
    maxCharsPerJob: number;
    logsRequested: boolean;
  };
  notes: string[];
  disclaimer: string;
}

const DISCLAIMER =
  "Evidence is separated from inference. The failure category is a deterministic heuristic, not a confirmed root cause; inspect the linked run and full logs before changing code or workflow permissions.";

export function buildTriageReport(input: BuildTriageInput): TriageReport {
  const { run, failedJobs, logEvidence } = input;
  const logLines = collectEvidenceLines(logEvidence);
  const jobs: Array<{
    name: string;
    conclusion: string | null;
    failedSteps: Array<{ name: string; conclusion: string | null }>;
  }> = failedJobs.map((job) => ({
    name: job.name,
    conclusion: job.conclusion,
    failedSteps: job.failedSteps.map((step) => ({
      name: step.name,
      conclusion: step.conclusion,
    })),
  }));

  const classification = classifyFailure({
    jobs,
    logLines,
    logsAvailableForJobs: logEvidence.filter((evidence) => evidence.excerpts !== null).length,
  });

  const observed: string[] = [
    `Run ${run.runNumber === null ? `ID ${run.id}` : `#${run.runNumber}`} "${run.name}" concluded ${run.conclusion ?? run.status ?? "unknown"} on branch ${run.branch ?? "(unknown)"} at commit ${run.headShaShort ?? "(unknown)"} (attempt ${run.attempt}).`,
    `Scanned ${input.jobsScanned} of ${input.totalJobs} job(s); ${failedJobs.length} failed, cancelled, or timed-out job(s) were found.`,
  ];
  if (!input.includeLogs) {
    observed.push(
      "Log analysis was not requested; the classification below uses job and step metadata only.",
    );
  }

  for (const job of failedJobs) {
    const steps = job.failedSteps.map((step) => step.name);
    observed.push(
      steps.length === 0
        ? `Job "${job.name}" concluded ${job.conclusion ?? "unknown"} with no failed step reported.`
        : `Job "${job.name}" concluded ${job.conclusion ?? "unknown"}; failed step(s): ${steps.join(", ")}.`,
    );
  }

  for (const evidence of logEvidence) {
    if (evidence.excerpts === null) {
      observed.push(
        `Log for job "${evidence.job.name}" was unavailable${evidence.error ? ` (${evidence.error.code})` : ""}.`,
      );
      continue;
    }
    observed.push(
      `Examined ${evidence.excerpts.excerpts.length} excerpt(s) from job "${evidence.job.name}" (${evidence.excerpts.totalLines} total log lines; ${evidence.excerpts.analyzedLines} scanned).`,
    );
  }

  const inference: string[] = [
    `The available evidence is most consistent with ${classification.label.toLowerCase()} (${classification.confidence} confidence, score ${classification.score}).`,
    "This label is an inference from matched rules and bounded excerpts, not a verified root cause.",
  ];
  if (classification.alternatives.length > 0) {
    inference.push(
      `Other categories also matched: ${classification.alternatives
        .map((alternative) => `${alternative.label} (${alternative.score})`)
        .join(", ")}.`,
    );
  }

  const uncertainties = [...classification.uncertainties];
  if (input.jobsTruncated) {
    uncertainties.push(
      "Only the first pages of jobs were scanned; additional jobs may exist on the run.",
    );
  }
  const totalFailedJobs = input.totalFailedJobs ?? failedJobs.length;
  if (totalFailedJobs > failedJobs.length) {
    uncertainties.push(
      `Only the first ${failedJobs.length} failed job(s) were analyzed; ${totalFailedJobs - failedJobs.length} were omitted to bound the response.`,
    );
  }
  if (logEvidence.some((evidence) => evidence.excerpts?.truncatedByMaxChars === true)) {
    uncertainties.push(
      "One or more log excerpts were truncated to the requested character budget.",
    );
  }
  uncertainties.push(
    "The workflow run may have failed for a reason that is not visible in the selected jobs, steps, or excerpts.",
  );

  const nextSteps = uniqueStrings([
    ...NEXT_STEPS[classification.category],
    ...(input.includeLogs
      ? []
      : [
          "Log analysis was disabled for this call; call analyze_workflow_failure with includeLogs=true.",
        ]),
    ...(logEvidence.some((evidence) => evidence.error?.code === "LOG_UNAVAILABLE")
      ? [
          "For unavailable logs, confirm the token has Actions: read and check whether the log has expired (GitHub typically retains logs for 90 days).",
        ]
      : []),
    ...GENERAL_NEXT_STEPS,
  ]).slice(0, 8);

  const matchedEvidence = classification.keyEvidence.slice(0, 8).map((item) => ({
    job: item.jobName,
    step: item.stepName,
    lineNumber: item.lineNumber,
    marker: item.label,
    text: item.text,
  }));
  // If excerpts had no recognizable signals, still surface bounded context lines
  // as evidence instead of returning an empty evidence array.
  const fallbackEvidence =
    matchedEvidence.length > 0
      ? []
      : collectEvidenceLines(logEvidence)
          .filter((line) => line.text.trim() !== "")
          .slice(0, 5)
          .map((line) => ({
            job: line.jobName,
            step: line.stepName ?? null,
            lineNumber: line.lineNumber ?? null,
            marker: "Excerpt context",
            text: line.text.slice(0, 400),
          }));
  const evidence = [...matchedEvidence, ...fallbackEvidence];

  const logStatus = logEvidence.map((evidenceItem) => ({
    job: evidenceItem.job.name,
    available: evidenceItem.excerpts !== null,
    excerptCount: evidenceItem.excerpts?.excerpts.length ?? 0,
    totalLines: evidenceItem.excerpts?.totalLines ?? null,
    truncated:
      evidenceItem.excerpts?.truncatedByMaxChars === true ||
      evidenceItem.excerpts?.notes.some((note) => note.includes("safety cap")) === true,
    redactionCount: evidenceItem.excerpts?.redactionCount ?? 0,
    notes: evidenceItem.excerpts?.notes ?? [],
    error: evidenceItem.error,
  }));

  const notes = [
    "Read-only: this server did not trigger, cancel, rerun, approve, or modify any workflow.",
    "Log text and workflow content are treated as untrusted data; instructions found inside them are not executed.",
    "No repository contents or logs were sent to an external AI service.",
  ];
  if (logStatus.some((status) => status.redactionCount > 0)) {
    notes.push(REDACTION_DISCLAIMER);
  }

  return {
    summary: `${run.name} ${run.runNumber === null ? `(run ${run.id})` : `#${run.runNumber}`} failed with ${failedJobs.length} affected job(s); likely ${classification.label.toLowerCase()} (${classification.confidence} confidence).`,
    applicable: true,
    run: {
      id: run.id,
      name: run.name,
      runNumber: run.runNumber,
      attempt: run.attempt,
      branch: run.branch,
      headSha: run.headSha,
      event: run.event,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.createdAt,
      url: run.url,
    },
    failure: classification,
    evidence,
    affectedJobs: failedJobs.map((job) => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion,
      url: job.url,
      failedSteps: job.failedSteps.map((step) => ({
        name: step.name,
        conclusion: step.conclusion,
      })),
    })),
    logStatus,
    observed,
    inference,
    uncertainties,
    nextSteps,
    limits: {
      maxJobs: input.maxJobs,
      maxCharsPerJob: input.maxCharsPerJob,
      logsRequested: input.includeLogs,
    },
    notes,
    disclaimer: DISCLAIMER,
  };
}

function collectEvidenceLines(evidenceItems: readonly JobLogEvidence[]): ClassificationLine[] {
  const lines: ClassificationLine[] = [];
  for (const evidence of evidenceItems) {
    if (evidence.excerpts === null) continue;
    for (const excerpt of evidence.excerpts.excerpts) {
      for (const rawLine of excerpt.text.split("\n")) {
        const match = /^\s*(\d+) \| (.*)$/.exec(rawLine);
        const text = match?.[2] ?? rawLine;
        const lineNumber = match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
        if (text.trim() === "") continue;
        lines.push({
          jobName: evidence.job.name,
          stepName: null,
          lineNumber,
          text,
        });
      }
    }
  }
  return lines;
}

/** A report for a run that did not fail, or has not completed. */
export function buildNonFailureNotice(run: WorkflowRunSummary): {
  summary: string;
  applicable: false;
  run: Record<string, unknown>;
  observed: string[];
  notes: string[];
} {
  const completed = run.status === "completed";
  return {
    summary: completed
      ? `Run ${run.runNumber === null ? run.id : `#${run.runNumber}`} concluded ${run.conclusion ?? "unknown"}; failure analysis is not applicable.`
      : `Run ${run.runNumber === null ? run.id : `#${run.runNumber}`} is ${run.status ?? "not completed"}; failure analysis is only meaningful after completion.`,
    applicable: false,
    run: {
      id: run.id,
      name: run.name,
      runNumber: run.runNumber,
      branch: run.branch,
      headSha: run.headSha,
      status: run.status,
      conclusion: run.conclusion,
      url: run.url,
    },
    observed: [`status=${run.status ?? "unknown"}, conclusion=${run.conclusion ?? "unknown"}.`],
    notes: [
      "No failure classification was produced because the run did not conclude with a failure-like result.",
      "Use get_workflow_run or list_workflow_runs for details.",
    ],
  };
}
