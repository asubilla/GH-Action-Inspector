import { CATEGORY_LABELS, CATEGORY_PRIORITY, type FailureCategory } from "./categories.js";
import { matchSignals } from "./signals.js";

export type Confidence = "high" | "medium" | "low";
export type EvidenceSource = "job-conclusion" | "step-name" | "job-name" | "log";

export interface ClassificationJob {
  name: string;
  conclusion: string | null;
  failedSteps: ReadonlyArray<{ name: string; conclusion: string | null }>;
}

export interface ClassificationLine {
  jobName: string;
  stepName?: string | null;
  lineNumber?: number | null;
  text: string;
}

export interface ClassificationInput {
  jobs: readonly ClassificationJob[];
  /** Lines taken only from bounded, redacted log excerpts. */
  logLines: readonly ClassificationLine[];
  logsAvailableForJobs: number;
}

export interface MatchedRule {
  id: string;
  label: string;
  category: FailureCategory;
  score: number;
  evidenceCount: number;
  sources: EvidenceSource[];
}

export interface KeyEvidence {
  category: FailureCategory;
  signalId: string;
  label: string;
  jobName: string;
  stepName: string | null;
  lineNumber: number | null;
  text: string;
}

export interface Classification {
  category: FailureCategory;
  label: string;
  confidence: Confidence;
  score: number;
  basis: "log-and-metadata" | "metadata-only";
  alternatives: Array<{ category: FailureCategory; label: string; score: number }>;
  matchedRules: MatchedRule[];
  keyEvidence: KeyEvidence[];
  reasoning: string[];
  uncertainties: string[];
}

interface RuleAccumulator {
  id: string;
  category: FailureCategory;
  label: string;
  score: number;
  evidenceCount: number;
  sources: Set<EvidenceSource>;
}

/**
 * Step and job names are weaker evidence than log text, but they remain useful
 * when a log is expired or inaccessible. Weights are intentionally small so a
 * clear log signal always outranks a generic name such as "test".
 */
const NAME_KEYWORDS: ReadonlyArray<{
  category: FailureCategory;
  weight: number;
  pattern: RegExp;
}> = [
  {
    category: "type_check_failure",
    weight: 2,
    pattern: /type-?check|typescript|\btsc\b|\bmypy\b|pyright/i,
  },
  {
    category: "lint_failure",
    weight: 2,
    pattern: /\blint\b|eslint|prettier|stylelint|rubocop|ruff/i,
  },
  {
    category: "test_failure",
    weight: 2,
    pattern: /\btest|spec\b|jest|vitest|pytest|phpunit|rspec|mocha/i,
  },
  {
    category: "dependency_installation",
    weight: 2,
    pattern: /install|dependenc|npm ci|yarn|pnpm|\bpip\b|composer|bundle/i,
  },
  { category: "build_failure", weight: 2, pattern: /\bbuild\b|compile|bundle|package\b|docker/i },
  { category: "timeout", weight: 2, pattern: /timeout|time limit/i },
  { category: "permissions", weight: 2, pattern: /permission|auth|token/i },
];

const MAX_RULE_SCORE_FROM_LOGS = 15;

export function classifyFailure(input: ClassificationInput): Classification {
  const scores = new Map<FailureCategory, number>();
  const rules = new Map<string, RuleAccumulator>();
  const evidence: KeyEvidence[] = [];
  const reasoning: string[] = [];

  const addScore = (
    category: FailureCategory,
    amount: number,
    source: EvidenceSource,
    ruleId: string,
    ruleLabel: string,
    evidenceCandidate?: Omit<KeyEvidence, "category">,
  ): void => {
    scores.set(category, (scores.get(category) ?? 0) + amount);
    const rule = rules.get(ruleId) ?? {
      id: ruleId,
      category,
      label: ruleLabel,
      score: 0,
      evidenceCount: 0,
      sources: new Set<EvidenceSource>(),
    };
    if (amount > 0) {
      rule.score += amount;
      rule.evidenceCount += 1;
      rule.sources.add(source);
      rules.set(ruleId, rule);
    }
    if (evidenceCandidate !== undefined) {
      evidence.push({ category, ...evidenceCandidate });
    }
  };

  for (const job of input.jobs) {
    if (job.conclusion === "timed_out") {
      addScore(
        "timeout",
        8,
        "job-conclusion",
        "job-conclusion-timed-out",
        "Job concluded timed_out",
      );
      reasoning.push(`Job "${job.name}" concluded with timed_out.`);
    }
    if (job.conclusion === "cancelled") {
      addScore(
        "cancelled",
        8,
        "job-conclusion",
        "job-conclusion-cancelled",
        "Job concluded cancelled",
      );
      reasoning.push(`Job "${job.name}" concluded with cancelled.`);
    }

    for (const keyword of NAME_KEYWORDS) {
      if (keyword.pattern.test(job.name)) {
        addScore(
          keyword.category,
          keyword.weight,
          "job-name",
          `job-name-${keyword.category}`,
          "Job name indicates the failed area",
        );
      }
    }

    for (const step of job.failedSteps) {
      if (step.conclusion === "timed_out") {
        addScore(
          "timeout",
          6,
          "job-conclusion",
          "step-conclusion-timed-out",
          "Step concluded timed_out",
        );
      }
      for (const keyword of NAME_KEYWORDS) {
        if (keyword.pattern.test(step.name)) {
          addScore(
            keyword.category,
            keyword.weight * 2,
            "step-name",
            `step-name-${keyword.category}`,
            "Failed step name indicates the area",
          );
        }
      }
    }
  }

  const logRuleScores = new Map<string, number>();
  for (const line of input.logLines) {
    const signals = matchSignals(line.text);
    for (const signal of signals) {
      const currentRuleScore = logRuleScores.get(signal.id) ?? 0;
      if (currentRuleScore >= MAX_RULE_SCORE_FROM_LOGS) continue;
      const contribution = Math.min(signal.weight, MAX_RULE_SCORE_FROM_LOGS - currentRuleScore);
      logRuleScores.set(signal.id, currentRuleScore + contribution);
      addScore(signal.category, contribution, "log", signal.id, signal.label, {
        signalId: signal.id,
        label: signal.label,
        jobName: line.jobName,
        stepName: line.stepName ?? null,
        lineNumber: line.lineNumber ?? null,
        text: line.text.slice(0, 400),
      });
    }
  }

  const ranked = [...scores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return CATEGORY_PRIORITY.indexOf(a[0]) - CATEGORY_PRIORITY.indexOf(b[0]);
    });

  const top = ranked[0];
  const basis: Classification["basis"] =
    input.logLines.length > 0 ? "log-and-metadata" : "metadata-only";

  if (top === undefined) {
    return {
      category: "unknown",
      label: CATEGORY_LABELS.unknown,
      confidence: "low",
      score: 0,
      basis,
      alternatives: [],
      matchedRules: [],
      keyEvidence: [],
      reasoning: [
        "No deterministic failure signals matched the available job metadata or log excerpts.",
      ],
      uncertainties: buildUncertainties(input, true, ranked.length),
    };
  }

  const [category, score] = top;
  const secondScore = ranked[1]?.[1] ?? 0;
  const hasStructuredTimeout = input.jobs.some(
    (job) =>
      job.conclusion === "timed_out" ||
      job.failedSteps.some((step) => step.conclusion === "timed_out"),
  );
  const hasStructuredCancellation = input.jobs.some((job) => job.conclusion === "cancelled");
  // High confidence requires either a structured job/step conclusion or a
  // decisive lead from explicit log evidence. A single generic "error" line is
  // never enough.
  const highConfidenceAllowed =
    (category === "timeout" && hasStructuredTimeout) ||
    (category === "cancelled" && hasStructuredCancellation) ||
    (input.logLines.length > 0 && score >= 6 && (secondScore === 0 || score >= secondScore * 1.8));

  const confidence: Confidence = highConfidenceAllowed ? "high" : score >= 6 ? "medium" : "low";

  const matchedRules = [...rules.values()]
    .filter((rule) => rule.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      category: rule.category,
      score: rule.score,
      evidenceCount: rule.evidenceCount,
      sources: [...rule.sources].sort(),
    }));

  for (const rule of matchedRules.slice(0, 3)) {
    reasoning.push(
      `Signal "${rule.label}" contributed ${rule.score} point(s) from ${rule.sources.join(", ")}.`,
    );
  }

  const sortedEvidence = [...evidence]
    .sort((a, b) => scoreForSignal(b.signalId) - scoreForSignal(a.signalId))
    .slice(0, 8);

  return {
    category,
    label: CATEGORY_LABELS[category],
    confidence,
    score,
    basis,
    alternatives: ranked.slice(1, 4).map(([alternativeCategory, alternativeScore]) => ({
      category: alternativeCategory,
      label: CATEGORY_LABELS[alternativeCategory],
      score: alternativeScore,
    })),
    matchedRules,
    keyEvidence: sortedEvidence,
    reasoning,
    uncertainties: buildUncertainties(input, false, ranked.length),
  };
}

function scoreForSignal(signalId: string): number {
  return signalId.includes("permission")
    ? 6
    : signalId.includes("timeout")
      ? 6
      : signalId.includes("assertion") || signalId.includes("type-check")
        ? 5
        : 3;
}

function buildUncertainties(
  input: ClassificationInput,
  empty: boolean,
  rankedCount: number,
): string[] {
  const uncertainties: string[] = [];
  if (input.logLines.length === 0) {
    uncertainties.push(
      "No log excerpts were available; classification relies only on job and step metadata.",
    );
  }
  if (input.logsAvailableForJobs < input.jobs.length) {
    uncertainties.push(
      `Logs were unavailable for ${input.jobs.length - input.logsAvailableForJobs} of ${input.jobs.length} failed job(s).`,
    );
  }
  if (empty) {
    uncertainties.push("There was not enough evidence to assign a failure category.");
  }
  if (rankedCount > 1 && !empty) {
    uncertainties.push(
      "Multiple categories matched. See alternatives and matched rules before acting on the primary category.",
    );
  }
  uncertainties.push(
    "This is a deterministic heuristic over a bounded excerpt, not a confirmed root cause.",
  );
  return uncertainties;
}
