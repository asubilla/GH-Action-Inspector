import { describe, expect, it } from "vitest";
import { extractLogExcerpts, MAX_ANALYZED_LINES } from "../src/log/excerpts.js";
import { failingTestLog } from "./helpers/factories.js";

describe("log excerpt extraction", () => {
  it("returns bounded excerpts around failure markers with line numbers", () => {
    const result = extractLogExcerpts(failingTestLog(), {
      maxChars: 2_000,
      contextLines: 2,
      maxExcerpts: 3,
    });

    expect(result.hasFailureMarkers).toBe(true);
    expect(result.totalLines).toBe(6);
    expect(result.excerpts).toHaveLength(1);
    expect(result.excerpts[0]?.startLine).toBe(1);
    expect(result.excerpts[0]?.text).toContain("AssertionError");
    expect(result.excerpts[0]?.text).toMatch(/^\s*1 \| /);
    expect(result.matchedMarkers.length).toBeGreaterThan(0);
  });

  it("never exceeds maxChars", () => {
    const lines: string[] = [];
    for (let index = 0; index < 200; index += 1) {
      lines.push(`error: synthetic failure number ${index} with some padding text`);
    }
    const result = extractLogExcerpts(lines.join("\n"), {
      maxChars: 800,
      contextLines: 3,
      maxExcerpts: 10,
    });
    const total = result.excerpts.map((excerpt) => excerpt.text).join("\n\n").length;
    expect(total).toBeLessThanOrEqual(800);
    expect(result.truncatedByMaxChars).toBe(true);
  });

  it("handles empty logs", () => {
    const result = extractLogExcerpts("   \n\n", { maxChars: 1_000 });
    expect(result.totalLines).toBe(0);
    expect(result.excerpts).toEqual([]);
    expect(result.hasFailureMarkers).toBe(false);
    expect(result.notes[0]).toMatch(/empty/i);
  });

  it("falls back to head and tail when no markers are present", () => {
    const lines = Array.from({ length: 120 }, (_value, index) => `plain log line ${index + 1}`);
    const result = extractLogExcerpts(lines.join("\n"), { maxChars: 4_000 });
    expect(result.hasFailureMarkers).toBe(false);
    expect(result.excerpts.length).toBeGreaterThanOrEqual(1);
    const joined = result.excerpts.map((excerpt) => excerpt.text).join("\n");
    expect(joined).toContain("plain log line 1");
    expect(joined).toContain("plain log line 120");
    expect(result.notes.some((note) => /No recognizable failure markers/.test(note))).toBe(true);
  });

  it("strips ANSI escapes and GitHub log timestamps", () => {
    const log = "\u001b[31m2026-01-10T10:00:00.0000000Z error: boom\u001b[0m";
    const result = extractLogExcerpts(log, { maxChars: 500 });
    expect(result.excerpts[0]?.text).not.toContain("\u001b");
    expect(result.excerpts[0]?.text).not.toContain("2026-01-10T");
    expect(result.excerpts[0]?.text).toContain("error: boom");
  });

  it("redacts secrets before returning excerpt text", () => {
    const fakeToken = `ghp_${"Q".repeat(36)}`;
    const log = `error: request failed with TOKEN=${fakeToken}\n##[error]exit 1`;
    const result = extractLogExcerpts(log, { maxChars: 1_000 });
    expect(result.excerpts[0]?.text).not.toContain(fakeToken);
    expect(result.redactionCount).toBeGreaterThan(0);
    expect(result.notes.some((note) => /best-effort/i.test(note))).toBe(true);
  });

  it("bounds analysis for very large logs and preserves original line numbers", () => {
    const lines = Array.from({ length: MAX_ANALYZED_LINES + 5_000 }, (_value, index) => {
      return index === MAX_ANALYZED_LINES + 4_000 ? "##[error] late failure" : `line ${index + 1}`;
    });
    const result = extractLogExcerpts(lines.join("\n"), { maxChars: 2_000 });
    expect(result.totalLines).toBe(lines.length);
    expect(result.analyzedLines).toBeLessThanOrEqual(MAX_ANALYZED_LINES);
    expect(result.omittedLines).toBeGreaterThan(0);
    expect(result.excerpts[0]?.startLine).toBeGreaterThan(MAX_ANALYZED_LINES);
    expect(result.notes.some((note) => /not scanned/.test(note))).toBe(true);
  });

  it("notes a download that was already truncated by size", () => {
    const result = extractLogExcerpts(
      "##[error] boom",
      { maxChars: 500 },
      { truncatedBySize: true },
    );
    expect(result.notes.some((note) => /safety cap/.test(note))).toBe(true);
  });

  it("respects maxExcerpts and preserves chronological order", () => {
    const lines = Array.from({ length: 120 }, (_value, index) => {
      return index % 20 === 0 ? `error: failure ${index}` : `line ${index}`;
    });
    const result = extractLogExcerpts(lines.join("\n"), {
      maxChars: 5_000,
      contextLines: 2,
      maxExcerpts: 2,
    });
    expect(result.excerpts.length).toBeLessThanOrEqual(2);
    const starts = result.excerpts.map((excerpt) => excerpt.startLine);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });
});
