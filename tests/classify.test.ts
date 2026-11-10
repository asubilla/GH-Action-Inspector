import { describe, expect, it } from "vitest";
import { classifyFailure, type ClassificationInput } from "../src/analysis/classify.js";
import { buildTriageReport } from "../src/analysis/triage.js";
import { makeJob, makeRun } from "./helpers/factories.js";

function input(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    jobs: [],
    logLines: [],
    logsAvailableForJobs: 0,
    ...overrides,
  };
}

describe("failure classification", () => {
  it("classifies test assertion failures from log evidence", () => {
    const result = classifyFailure(
      input({
        jobs: [
          {
            name: "test",
            conclusion: "failure",
            failedSteps: [{ name: "Run npm test", conclusion: "failure" }],
          },
        ],
        logLines: [
          {
            jobName: "test",
            lineNumber: 12,
            text: "FAIL src/sum.test.ts > adds numbers",
          },
          {
            jobName: "test",
            lineNumber: 13,
            text: "AssertionError: expected 2 to be 3",
          },
        ],
        logsAvailableForJobs: 1,
      }),
    );

    expect(result.category).toBe("test_failure");
    expect(result.confidence).not.toBe("low");
    expect(result.matchedRules.some((rule) => rule.sources.includes("log"))).toBe(true);
    expect(result.keyEvidence.length).toBeGreaterThan(0);
    expect(result.basis).toBe("log-and-metadata");
  });

  it("classifies TypeScript errors", () => {
    const result = classifyFailure(
      input({
        jobs: [
          {
            name: "typecheck",
            conclusion: "failure",
            failedSteps: [{ name: "tsc", conclusion: "failure" }],
          },
        ],
        logLines: [
          {
            jobName: "typecheck",
            text: "src/app.ts(4,7): error TS2322: Type 'string' is not assignable to type 'number'.",
          },
        ],
        logsAvailableForJobs: 1,
      }),
    );
    expect(result.category).toBe("type_check_failure");
    expect(result.confidence).toBe("high");
  });

  it("classifies dependency resolution failures", () => {
    const result = classifyFailure(
      input({
        jobs: [
          {
            name: "install",
            conclusion: "failure",
            failedSteps: [{ name: "npm ci", conclusion: "failure" }],
          },
        ],
        logLines: [
          { jobName: "install", text: "npm error code ERESOLVE" },
          { jobName: "install", text: "npm error unable to resolve dependency tree" },
        ],
        logsAvailableForJobs: 1,
      }),
    );
    expect(result.category).toBe("dependency_installation");
  });

  it("classifies permission failures", () => {
    const result = classifyFailure(
      input({
        jobs: [
          {
            name: "comment",
            conclusion: "failure",
            failedSteps: [{ name: "gh api", conclusion: "failure" }],
          },
        ],
        logLines: [
          {
            jobName: "comment",
            text: "gh: Resource not accessible by integration (403)",
          },
        ],
        logsAvailableForJobs: 1,
      }),
    );
    expect(result.category).toBe("permissions");
    expect(result.confidence).toBe("high");
  });

  it("uses job conclusions for timeouts and cancellations", () => {
    const timeout = classifyFailure(
      input({
        jobs: [{ name: "e2e", conclusion: "timed_out", failedSteps: [] }],
        logsAvailableForJobs: 0,
      }),
    );
    expect(timeout.category).toBe("timeout");
    expect(timeout.confidence).toBe("high");

    const cancelled = classifyFailure(
      input({
        jobs: [{ name: "deploy", conclusion: "cancelled", failedSteps: [] }],
        logsAvailableForJobs: 0,
      }),
    );
    expect(cancelled.category).toBe("cancelled");
    expect(cancelled.confidence).toBe("high");
  });

  it("does not claim high confidence from names alone", () => {
    const result = classifyFailure(
      input({
        jobs: [
          {
            name: "test",
            conclusion: "failure",
            failedSteps: [{ name: "Run tests", conclusion: "failure" }],
          },
        ],
        logsAvailableForJobs: 0,
      }),
    );
    expect(result.basis).toBe("metadata-only");
    expect(result.confidence).not.toBe("high");
    expect(result.uncertainties.some((item) => /No log excerpts/.test(item))).toBe(true);
  });

  it("returns unknown with low confidence when nothing matches", () => {
    const result = classifyFailure(
      input({
        jobs: [
          {
            name: "mystery",
            conclusion: "failure",
            failedSteps: [{ name: "Step", conclusion: "failure" }],
          },
        ],
        logsAvailableForJobs: 0,
      }),
    );
    expect(result.category).toBe("unknown");
    expect(result.confidence).toBe("low");
    expect(result.alternatives).toEqual([]);
  });

  it("reports ambiguous alternatives rather than hiding them", () => {
    const result = classifyFailure(
      input({
        jobs: [{ name: "test-and-lint", conclusion: "failure", failedSteps: [] }],
        logLines: [
          { jobName: "test-and-lint", text: "eslint error: no-unused-vars" },
          { jobName: "test-and-lint", text: "AssertionError: expected true to be false" },
        ],
        logsAvailableForJobs: 1,
      }),
    );
    expect(result.alternatives.length).toBeGreaterThan(0);
    expect(result.uncertainties.some((item) => /Multiple categories/.test(item))).toBe(true);
  });

  it("separates observed facts from inference in a triage report", () => {
    const job = makeJob();
    const report = buildTriageReport({
      run: makeRun(),
      failedJobs: [job],
      logEvidence: [
        {
          job,
          excerpts: {
            excerpts: [
              {
                startLine: 3,
                endLine: 4,
                text: "  3 | FAIL src/sum.test.ts\n  4 | AssertionError: expected 2 to be 3",
                markers: ["test_failure"],
              },
            ],
            matchedMarkers: ["Test assertion failure"],
            totalLines: 6,
            analyzedLines: 6,
            omittedLines: 0,
            truncatedByMaxChars: false,
            redactionCount: 0,
            redactionCategories: [],
            maskedPlaceholderCount: 0,
            hasFailureMarkers: true,
            notes: [],
          },
          error: null,
        },
      ],
      jobsScanned: 1,
      totalJobs: 1,
      jobsTruncated: false,
      includeLogs: true,
      maxJobs: 5,
      maxCharsPerJob: 4_000,
    });

    expect(report.applicable).toBe(true);
    expect(report.failure.category).toBe("test_failure");
    expect(report.observed.some((line) => /concluded failure/i.test(line))).toBe(true);
    expect(report.inference.some((line) => /inference/i.test(line))).toBe(true);
    expect(report.nextSteps.length).toBeGreaterThan(0);
    expect(report.disclaimer).toMatch(/not a confirmed root cause/i);
    expect(report.notes.some((note) => /Read-only/.test(note))).toBe(true);
  });
});
