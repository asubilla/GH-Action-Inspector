export const FAILURE_CATEGORIES = [
  "test_failure",
  "lint_failure",
  "type_check_failure",
  "dependency_installation",
  "build_failure",
  "timeout",
  "permissions",
  "cancelled",
  "unknown",
] as const;

export type FailureCategory = (typeof FAILURE_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<FailureCategory, string> = {
  test_failure: "Test failure",
  lint_failure: "Lint failure",
  type_check_failure: "Type-check failure",
  dependency_installation: "Dependency installation failure",
  build_failure: "Build failure",
  timeout: "Timeout or job time limit",
  permissions: "Permissions or authentication failure",
  cancelled: "Cancelled run or job",
  unknown: "Unknown / insufficient evidence",
};

/** Priority used only to make tie-breaking deterministic. */
export const CATEGORY_PRIORITY: readonly FailureCategory[] = [
  "permissions",
  "timeout",
  "dependency_installation",
  "type_check_failure",
  "lint_failure",
  "test_failure",
  "build_failure",
  "cancelled",
  "unknown",
];

export const NEXT_STEPS: Record<FailureCategory, readonly string[]> = {
  test_failure: [
    "Identify the failing test and command from the log excerpt, then run that command locally on the same commit.",
    "Check whether the test is flaky by comparing with previous runs of the same workflow and branch.",
    "Inspect assertions and fixtures near the reported failure rather than guessing from the final exit code.",
  ],
  lint_failure: [
    "Run the repository's lint command locally and fix the reported rule violations.",
    "Check whether the failure comes from a newly added file or a version change in the linter configuration.",
    "Confirm the CI and local linter versions match.",
  ],
  type_check_failure: [
    "Run the repository's type-check command locally on the same commit.",
    "Read the first reported type error; later errors are often cascading.",
    "Check dependency or type-definition changes if the error references external packages.",
  ],
  dependency_installation: [
    "Check registry availability, authentication, and network access from the runner.",
    "Verify the lockfile is committed and matches the manifest; reproduce with the same install command.",
    "Look for a missing or mistyped package version, a private registry, or a package that was unpublished.",
  ],
  build_failure: [
    "Find the first compiler or bundler error in the log, not the final 'build failed' line.",
    "Reproduce the build locally with the same Node/toolchain version and environment variables.",
    "Check whether generated files, submodules, or build caches required by CI are present.",
  ],
  timeout: [
    "Check which step consumed the time and whether the job hit the workflow's timeout-minutes limit.",
    "Look for a hung process, an interactive prompt, a lock wait, or a network call without a timeout.",
    "Consider splitting slow test suites or caching dependencies, but only after confirming the bottleneck.",
  ],
  permissions: [
    "Compare the workflow's `permissions:` block with the API or resource it tried to access.",
    "For pull requests from forks, remember that GITHUB_TOKEN is read-only and secrets are unavailable.",
    "Check whether the token or GitHub App installation has the required repository scope.",
  ],
  cancelled: [
    "Determine whether the run was cancelled by a user, a concurrency group, or a newer run superseding it.",
    "Check the `concurrency` configuration and whether another run took priority.",
    "If the cancellation was intentional, investigate the superseding run instead.",
  ],
  unknown: [
    "Open the run URL and inspect the failed step's full log; the excerpt may not contain the root cause.",
    "Request a larger excerpt with get_job_log_excerpt, or inspect job step names and exit codes.",
    "Compare the run with the previous successful run for the same workflow and branch.",
  ],
};

export const GENERAL_NEXT_STEPS: readonly string[] = [
  "Use get_job_log_excerpt with a higher maxChars if the evidence excerpt is too small.",
  "Use compare_with_previous_run to see whether the same jobs and steps failed previously.",
  "Rerun from the GitHub UI only after reviewing the evidence; this server cannot rerun workflows.",
];
