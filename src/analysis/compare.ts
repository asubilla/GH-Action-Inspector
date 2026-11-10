import type { JobSummary, WorkflowRunSummary } from "../github/types.js";
import { durationSeconds, formatDuration, uniqueStrings } from "../util/text.js";

export interface RunComparison {
  summary: string;
  current: RunSnapshot;
  previous: RunSnapshot | null;
  differences: {
    commitChanged: boolean | null;
    sameCommit: boolean;
    branchChanged: boolean | null;
    eventChanged: boolean | null;
    attemptChanged: boolean | null;
    durationDeltaSeconds: number | null;
    durationDelta: string | null;
    newlyFailingJobs: string[];
    noLongerFailingJobs: string[];
    newlyFailingSteps: string[];
    noLongerFailingSteps: string[];
  } | null;
  observations: string[];
  possibleExplanations: string[];
  causation: "not_determined";
  notes: string[];
  links: {
    currentRun: string | null;
    previousRun: string | null;
  };
}

export interface RunSnapshot {
  id: number;
  name: string;
  runNumber: number | null;
  attempt: number;
  branch: string | null;
  headSha: string | null;
  headShaShort: string | null;
  event: string;
  status: string | null;
  conclusion: string | null;
  createdAt: string | null;
  durationSeconds: number | null;
  duration: string | null;
  url: string | null;
}

const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

export function toRunSnapshot(run: WorkflowRunSummary): RunSnapshot {
  const seconds = durationSeconds(run.startedAt ?? run.createdAt, run.updatedAt);
  return {
    id: run.id,
    name: run.name,
    runNumber: run.runNumber,
    attempt: run.attempt,
    branch: run.branch,
    headSha: run.headSha,
    headShaShort: run.headShaShort,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    createdAt: run.createdAt,
    durationSeconds: seconds,
    duration: formatDuration(seconds),
    url: run.url,
  };
}

export function buildRunComparison(
  current: WorkflowRunSummary,
  previous: WorkflowRunSummary | null,
  currentJobs: readonly JobSummary[],
  previousJobs: readonly JobSummary[],
  lookback: number,
): RunComparison {
  const currentSnapshot = toRunSnapshot(current);

  if (previous === null) {
    return {
      summary: `No previous successful run for workflow "${current.name}" on branch ${current.branch ?? "(unknown)"} was found in the last ${lookback} successful run(s).`,
      current: currentSnapshot,
      previous: null,
      differences: null,
      observations: [
        `Current run ${label(current)} concluded ${current.conclusion ?? current.status ?? "unknown"}.`,
        "A successful baseline was not available, so job, step, and timing differences cannot be computed.",
      ],
      possibleExplanations: [],
      causation: "not_determined",
      notes: [
        "Only completed successful runs of the same workflow and branch are considered.",
        "No commit diff is fetched; this tool reports only run metadata and failed job/step names.",
      ],
      links: {
        currentRun: current.url,
        previousRun: null,
      },
    };
  }

  const previousSnapshot = toRunSnapshot(previous);
  const currentFailedJobs = new Set(currentJobs.filter(isFailed).map((job) => job.name));
  const previousFailedJobs = new Set(previousJobs.filter(isFailed).map((job) => job.name));
  const currentFailedSteps = new Set(failedStepKeys(currentJobs));
  const previousFailedSteps = new Set(failedStepKeys(previousJobs));

  const newlyFailingJobs = [...currentFailedJobs].filter((name) => !previousFailedJobs.has(name));
  const noLongerFailingJobs = [...previousFailedJobs].filter(
    (name) => !currentFailedJobs.has(name),
  );
  const newlyFailingSteps = [...currentFailedSteps].filter((key) => !previousFailedSteps.has(key));
  const noLongerFailingSteps = [...previousFailedSteps].filter(
    (key) => !currentFailedSteps.has(key),
  );

  const sameCommit =
    current.headSha !== null && previous.headSha !== null && current.headSha === previous.headSha;
  const commitChanged = current.headSha !== null && previous.headSha !== null ? !sameCommit : null;
  const deltaSeconds =
    currentSnapshot.durationSeconds !== null && previousSnapshot.durationSeconds !== null
      ? currentSnapshot.durationSeconds - previousSnapshot.durationSeconds
      : null;

  const observations: string[] = [
    `Previous successful run ${label(previous)} concluded ${previous.conclusion ?? "unknown"} at commit ${previous.headShaShort ?? "(unknown)"} (${previous.createdAt ?? "date unknown"}).`,
    `Current run ${label(current)} concluded ${current.conclusion ?? "unknown"} at commit ${current.headShaShort ?? "(unknown)"}.`,
    sameCommit
      ? "Both runs point at the same head commit."
      : commitChanged === true
        ? "The runs point at different head commits."
        : "A head commit is missing for at least one run, so commit equality is unknown.",
  ];

  if (newlyFailingJobs.length > 0) {
    observations.push(`Failed only in the current run: ${newlyFailingJobs.join(", ")}.`);
  }
  if (noLongerFailingJobs.length > 0) {
    observations.push(`Failed only in the previous run: ${noLongerFailingJobs.join(", ")}.`);
  }
  if (newlyFailingSteps.length > 0) {
    observations.push(`Newly failing step(s): ${newlyFailingSteps.slice(0, 10).join("; ")}.`);
  }
  if (deltaSeconds !== null) {
    observations.push(
      `Current run duration differs from the previous run by ${formatDelta(deltaSeconds)}.`,
    );
  }

  const possibleExplanations: string[] = [];
  if (sameCommit) {
    possibleExplanations.push(
      "The same commit succeeded in the previous run, so the failure may be flaky, environment-dependent, or caused by a dependency, runner image, cache, or external service. This comparison cannot confirm which.",
    );
  } else if (commitChanged === true) {
    possibleExplanations.push(
      "The runs tested different commits. Changes between those commits are one possible explanation, but this comparison does not establish causation; inspect the commits and logs before concluding.",
    );
  }
  if (newlyFailingSteps.length > 0) {
    possibleExplanations.push(
      "The newly failing steps identify where to look first. They do not prove why the failure started.",
    );
  }

  const notes = [
    "Read-only: neither run was modified, rerun, or cancelled.",
    "Only completed successful runs of the same workflow and branch were considered.",
    "No code diff, artifact, or environment comparison is performed.",
    "No conclusion about causation is claimed from timing or commit differences alone.",
  ];

  return {
    summary: sameCommit
      ? `Both runs used commit ${current.headShaShort ?? "(unknown)"}; the current run failed while the previous run succeeded.`
      : `Compared failed run ${label(current)} with the most recent successful run ${label(previous)} for the same workflow and branch.`,
    current: currentSnapshot,
    previous: previousSnapshot,
    differences: {
      commitChanged,
      sameCommit,
      branchChanged:
        current.branch !== null && previous.branch !== null
          ? current.branch !== previous.branch
          : null,
      eventChanged: current.event !== previous.event,
      attemptChanged: current.attempt !== previous.attempt,
      durationDeltaSeconds: deltaSeconds,
      durationDelta: deltaSeconds === null ? null : formatDelta(deltaSeconds),
      newlyFailingJobs,
      noLongerFailingJobs,
      newlyFailingSteps,
      noLongerFailingSteps,
    },
    observations,
    possibleExplanations: uniqueStrings(possibleExplanations),
    causation: "not_determined",
    notes,
    links: {
      currentRun: current.url,
      previousRun: previous.url,
    },
  };
}

function isFailed(job: JobSummary): boolean {
  return job.conclusion !== null && FAILED_CONCLUSIONS.has(job.conclusion);
}

function failedStepKeys(jobs: readonly JobSummary[]): string[] {
  const keys: string[] = [];
  for (const job of jobs) {
    for (const step of job.failedSteps) {
      keys.push(`${job.name} › ${step.name}`);
    }
  }
  return keys;
}

function label(run: WorkflowRunSummary): string {
  return run.runNumber === null ? `#${run.id}` : `#${run.runNumber}`;
}

function formatDelta(seconds: number): string {
  if (seconds === 0) return "no change";
  const sign = seconds > 0 ? "+" : "-";
  return `${sign}${formatDuration(Math.abs(seconds)) ?? `${Math.abs(seconds)}s`}`;
}
