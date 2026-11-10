import type {
  JobSummary,
  RepositoryInfo,
  StepSummary,
  WorkflowFileInfo,
  WorkflowInfo,
  WorkflowRunSummary,
} from "../../src/github/types.js";

/**
 * Synthetic fixtures only. No value in this file is a real credential or from a
 * real repository. Fake tokens are constructed from repeated characters.
 */

export function makeRun(overrides: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    id: 1001,
    name: "CI",
    displayTitle: "Fix flaky test",
    workflowId: 77,
    path: ".github/workflows/ci.yml",
    runNumber: 42,
    attempt: 1,
    event: "push",
    status: "completed",
    conclusion: "failure",
    branch: "main",
    headSha: "abcdef1234567890abcdef1234567890abcdef12",
    headShaShort: "abcdef1",
    createdAt: "2026-01-10T10:00:00Z",
    updatedAt: "2026-01-10T10:05:00Z",
    startedAt: "2026-01-10T10:00:10Z",
    url: "https://github.com/example-org/example-repo/actions/runs/1001",
    actor: "octocat",
    ...overrides,
  };
}

export function makeStep(overrides: Partial<StepSummary> = {}): StepSummary {
  return {
    number: 3,
    name: "Run tests",
    status: "completed",
    conclusion: "failure",
    startedAt: "2026-01-10T10:01:00Z",
    completedAt: "2026-01-10T10:04:00Z",
    ...overrides,
  };
}

export function makeJob(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 5001,
    runId: 1001,
    runAttempt: 1,
    name: "test",
    status: "completed",
    conclusion: "failure",
    startedAt: "2026-01-10T10:00:20Z",
    completedAt: "2026-01-10T10:04:30Z",
    durationSeconds: 250,
    url: "https://github.com/example-org/example-repo/actions/runs/1001/job/5001",
    stepsCount: 5,
    failedSteps: [makeStep()],
    ...overrides,
  };
}

export function makeRepository(overrides: Partial<RepositoryInfo> = {}): RepositoryInfo {
  return {
    id: 9001,
    fullName: "example-org/example-repo",
    private: true,
    defaultBranch: "main",
    archived: false,
    disabled: false,
    url: "https://github.com/example-org/example-repo",
    permissions: { admin: false, maintain: false, push: false, triage: false, pull: true },
    ...overrides,
  };
}

export function makeWorkflow(overrides: Partial<WorkflowInfo> = {}): WorkflowInfo {
  return {
    id: 77,
    name: "CI",
    path: ".github/workflows/ci.yml",
    state: "active",
    url: "https://github.com/example-org/example-repo/actions/workflows/77",
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeWorkflowFile(overrides: Partial<WorkflowFileInfo> = {}): WorkflowFileInfo {
  return {
    path: ".github/workflows/ci.yml",
    sha: "1234567890abcdef1234567890abcdef12345678",
    sizeBytes: 180,
    htmlUrl: "https://github.com/example-org/example-repo/blob/main/.github/workflows/ci.yml",
    contentBase64: Buffer.from(
      [
        "name: CI",
        "on: [push, pull_request]",
        "jobs:",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: npm test",
        "",
      ].join("\n"),
      "utf8",
    ).toString("base64"),
    encoding: "base64",
    ...overrides,
  };
}

export function failingTestLog(): string {
  return [
    "2026-01-10T10:01:00.0000000Z ##[group]Run npm test",
    "2026-01-10T10:01:00.0000000Z > vitest run",
    "2026-01-10T10:01:05.0000000Z FAIL src/sum.test.ts > sum adds numbers",
    "2026-01-10T10:01:05.0000000Z AssertionError: expected 2 to be 3",
    "2026-01-10T10:01:05.0000000Z   at src/sum.test.ts:12:5",
    "2026-01-10T10:01:06.0000000Z ##[error]Process completed with exit code 1.",
  ].join("\n");
}

export function typecheckLog(): string {
  return [
    "2026-01-10T10:01:00.0000000Z > tsc --noEmit",
    "2026-01-10T10:01:02.0000000Z src/app.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    "2026-01-10T10:01:02.0000000Z ##[error]Process completed with exit code 2.",
  ].join("\n");
}

export function dependencyLog(): string {
  return [
    "2026-01-10T10:00:20.0000000Z npm error code ERESOLVE",
    "2026-01-10T10:00:20.0000000Z npm error ERESOLVE unable to resolve dependency tree",
    "2026-01-10T10:00:21.0000000Z ##[error]Process completed with exit code 1.",
  ].join("\n");
}

export function permissionLog(): string {
  return [
    "2026-01-10T10:00:20.0000000Z gh: Resource not accessible by integration (403)",
    "2026-01-10T10:00:20.0000000Z ##[error]Process completed with exit code 1.",
  ].join("\n");
}
