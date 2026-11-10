import type { FailureCategory } from "./categories.js";

/**
 * Deterministic, transparent failure signals.
 *
 * These are heuristics over short text: job names, failed step names, and log
 * excerpt lines. They are not a model and do not prove a root cause. Each signal
 * has a stable id, a human-readable label, and a small integer weight so scores
 * can be explained in tool output.
 */
export interface FailureSignal {
  readonly id: string;
  readonly category: FailureCategory;
  readonly label: string;
  readonly weight: number;
  readonly pattern: RegExp;
}

export const FAILURE_SIGNALS: readonly FailureSignal[] = [
  {
    id: "permission-denied",
    category: "permissions",
    label: "Permission or authentication error",
    weight: 6,
    pattern:
      /\b(?:resource not accessible by (?:integration|personal access token)|permission denied|insufficient permissions|bad credentials|403 forbidden|refusing to allow|github_token permissions|unauthorized|eacces)\b/i,
  },
  {
    id: "auth-token-failure",
    category: "permissions",
    label: "Token authentication failure",
    weight: 5,
    pattern:
      /\b(?:authentication failed|invalid token|could not read username|terminal prompts disabled|requires authentication|not authorized)\b/i,
  },
  {
    id: "job-timeout",
    category: "timeout",
    label: "Timeout or execution limit",
    weight: 6,
    pattern:
      /\b(?:timed out|timeout of \d+|exceeded the maximum execution time|operation timed out|command timed out|etimedout|killed after|maximum execution time)\b/i,
  },
  {
    id: "dependency-resolution",
    category: "dependency_installation",
    label: "Dependency resolution error",
    weight: 5,
    pattern:
      /\b(?:eresolve|etarget|e404|eai_again|could not resolve (?:dependencies|host)|no matching distribution found|resolutionimpossible|could not find a version that satisfies|unable to resolve dependency|failed to resolve dependencies|no matching versions?)\b/i,
  },
  {
    id: "dependency-install",
    category: "dependency_installation",
    label: "Package installation error",
    weight: 4,
    pattern:
      /\b(?:npm (?:err!|error)|yarn install.*(?:failed|error)|pnpm install.*(?:err|failed)|pip install.*(?:error|failed)|poetry install.*(?:error|failed)|bundle install.*(?:error|failed)|composer install.*(?:error|failed)|go mod download.*(?:error|failed)|apt-get install.*(?:error|failed)|package installation failed)\b/i,
  },
  {
    id: "type-check-error",
    category: "type_check_failure",
    label: "TypeScript or type-checker error",
    weight: 6,
    pattern:
      /\b(?:error ts\d{4}|tsc.*(?:error|failed)|type error:|mypy.*error|pyright.*error|type-?check(?:ing)?.*(?:fail|error))\b/i,
  },
  {
    id: "lint-error",
    category: "lint_failure",
    label: "Linter or formatter failure",
    weight: 5,
    pattern:
      /\b(?:eslint|stylelint|ruff|flake8|pylint|rubocop|golangci-lint|markdownlint|prettier).*(?:error|warning|fail)|lint (?:error|failure)|lint failed|problems? found\b/i,
  },
  {
    id: "test-assertion",
    category: "test_failure",
    label: "Test assertion failure",
    weight: 6,
    pattern:
      /\b(?:assertionerror|assert(?:ion)? failed|expected .* to (?:be|equal|match|throw)|tests? failed|failing tests|test run failed|--- fail:)\b/i,
  },
  {
    id: "test-runner",
    category: "test_failure",
    label: "Test runner reported failures",
    weight: 4,
    pattern:
      /(?:^|\s)(?:fail|✕|✖|×)\s+\S|(?:jest|vitest|pytest|phpunit|rspec|mocha|go test).*(?:fail|error)/i,
  },
  {
    id: "build-error",
    category: "build_failure",
    label: "Compilation or build error",
    weight: 5,
    pattern:
      /\b(?:error: could not compile|build failed|build failure|compilation failed|compiler error|webpack.*error|rollup.*error|gradle.*failed|maven.*build failure|cmake error|msbuild.*error|failed to build|docker build.*(?:error|failed))\b/i,
  },
  {
    id: "cancelled",
    category: "cancelled",
    label: "Cancellation marker",
    weight: 4,
    pattern:
      /\b(?:cancel(?:l)?ed by user|job was cancelled|operation was canceled|run was cancelled)\b/i,
  },
  {
    id: "oom",
    category: "build_failure",
    label: "Resource exhaustion",
    weight: 3,
    pattern:
      /\b(?:out of memory|oomkilled|no space left on device|segmentation fault|killed by signal)\b/i,
  },
  {
    id: "command-not-found",
    category: "dependency_installation",
    label: "Missing command or file",
    weight: 2,
    pattern: /\b(?:command not found|not recognized as an internal or external command)\b/i,
  },
  {
    id: "generic-error",
    category: "unknown",
    label: "Generic error marker",
    weight: 1,
    pattern:
      /::error::|##\[error\]|\berror:|\bError:|\bfatal:|\bexception\b|\btraceback\b|\bprocess completed with exit code\b/i,
  },
  {
    id: "generic-failure",
    category: "unknown",
    label: "Generic failure wording",
    weight: 1,
    pattern: /\b(?:failed|failure|failed to|unsuccessful)\b/i,
  },
];

/**
 * Lightweight prefilter. A line that contains none of these substrings is very
 * unlikely to match any signal, so the regular expressions can be skipped.
 */
const PREFILTER =
  /error|fail|warn|denied|timeout|timed out|cancel|assert|exception|traceback|not found|unable|cannot|could not|oom|killed|✕|✖|×|eacces|etimedout|403/i;

export function lineMayContainSignal(line: string): boolean {
  return PREFILTER.test(line);
}

export function matchSignals(line: string): FailureSignal[] {
  const matches: FailureSignal[] = [];
  for (const signal of FAILURE_SIGNALS) {
    // Patterns are non-global, so .test has no lastIndex state.
    if (signal.pattern.test(line)) matches.push(signal);
  }
  return matches;
}
