import { lineMayContainSignal, matchSignals } from "../analysis/signals.js";
import { splitLogLines } from "./ansi.js";
import { redactSecrets, REDACTION_DISCLAIMER } from "./redact.js";
import { truncateText } from "../util/text.js";

/** Upper bound on lines scanned from a single log, even after download truncation. */
export const MAX_ANALYZED_LINES = 30_000;
const HEAD_LINES_WHEN_SAMPLING = 5_000;
const FALLBACK_HEAD_LINES = 25;
const FALLBACK_TAIL_LINES = 60;
const GROUP_SEPARATOR = "\n\n";

export interface ExcerptOptions {
  maxChars: number;
  contextLines?: number;
  maxExcerpts?: number;
  extraRedactionPatterns?: readonly RegExp[] | undefined;
}

export interface ExcerptSourceInfo {
  truncatedBySize?: boolean;
  downloadedBytes?: number;
}

export interface LogExcerpt {
  startLine: number;
  endLine: number;
  text: string;
  markers: string[];
}

export interface LogExcerptResult {
  excerpts: LogExcerpt[];
  matchedMarkers: string[];
  totalLines: number;
  analyzedLines: number;
  omittedLines: number;
  truncatedByMaxChars: boolean;
  redactionCount: number;
  redactionCategories: string[];
  maskedPlaceholderCount: number;
  hasFailureMarkers: boolean;
  notes: string[];
}

interface Segment {
  /** Original line number of the first line in this segment (0-based). */
  readonly offset: number;
  readonly lines: readonly string[];
}

interface Window {
  readonly segmentIndex: number;
  readonly start: number;
  readonly end: number;
  readonly score: number;
  readonly hitCount: number;
  readonly markers: ReadonlySet<string>;
}

/**
 * Extract only the interesting regions of a job log.
 *
 * The result is always bounded by maxChars. Full logs are never returned. If the
 * caller supplies a truncated download, excerpts may miss middle sections; this
 * is reported explicitly instead of being presented as complete evidence.
 */
export function extractLogExcerpts(
  logText: string,
  options: ExcerptOptions,
  source: ExcerptSourceInfo = {},
): LogExcerptResult {
  const maxChars = Math.max(0, Math.floor(options.maxChars));
  const contextLines = Math.min(8, Math.max(0, options.contextLines ?? 3));
  const maxExcerpts = Math.min(10, Math.max(1, options.maxExcerpts ?? 4));
  const allLines = splitLogLines(logText);
  const totalLines = allLines.length;

  if (totalLines === 0) {
    return {
      excerpts: [],
      matchedMarkers: [],
      totalLines: 0,
      analyzedLines: 0,
      omittedLines: 0,
      truncatedByMaxChars: false,
      redactionCount: 0,
      redactionCategories: [],
      maskedPlaceholderCount: 0,
      hasFailureMarkers: false,
      notes: ["The job log is empty or contains no readable text."],
    };
  }

  const segments = buildSegments(allLines);
  const analyzedLines = segments.reduce((count, segment) => count + segment.lines.length, 0);
  const omittedLines = totalLines - analyzedLines;

  const markers = new Set<string>();
  const windows: Window[] = [];
  let hasFailureMarkers = false;

  for (const [segmentIndex, segment] of segments.entries()) {
    const lineScores = new Array<number>(segment.lines.length).fill(0);
    const lineMarkers: Set<string>[] = segment.lines.map(() => new Set<string>());
    const selected = new Set<number>();

    for (const [index, line] of segment.lines.entries()) {
      if (!lineMayContainSignal(line)) continue;
      const signals = matchSignals(line);
      if (signals.length === 0) continue;

      hasFailureMarkers = true;
      for (const signal of signals) {
        markers.add(signal.label);
        lineScores[index] = Math.max(lineScores[index] ?? 0, signal.weight);
        lineMarkers[index]?.add(signal.id);
      }

      const start = Math.max(0, index - contextLines);
      const end = Math.min(segment.lines.length - 1, index + contextLines);
      for (let cursor = start; cursor <= end; cursor += 1) selected.add(cursor);
    }

    windows.push(...groupSelectedLines(segmentIndex, selected, lineScores, lineMarkers));
  }

  if (windows.length === 0) {
    // Graceful fallback for logs with no recognizable markers: show the head
    // (setup failures) and the tail (final exit) so the caller still gets data.
    for (const [segmentIndex, segment] of segments.entries()) {
      if (segment.lines.length === 0) continue;
      windows.push({
        segmentIndex,
        start: 0,
        end: Math.min(segment.lines.length - 1, FALLBACK_HEAD_LINES - 1),
        score: 0,
        hitCount: 0,
        markers: new Set<string>(),
      });
      const tailStart = Math.max(0, segment.lines.length - FALLBACK_TAIL_LINES);
      if (tailStart > FALLBACK_HEAD_LINES) {
        windows.push({
          segmentIndex,
          start: tailStart,
          end: segment.lines.length - 1,
          score: 0,
          hitCount: 0,
          markers: new Set<string>(),
        });
      }
    }
  }

  const selectedWindows = selectWindows(windows, maxExcerpts);
  const rendered = renderWindows(
    selectedWindows,
    segments,
    maxChars,
    options.extraRedactionPatterns,
  );

  const notes = buildNotes({
    totalLines,
    omittedLines,
    hasFailureMarkers,
    truncatedBySize: source.truncatedBySize === true,
    truncatedByMaxChars: rendered.truncatedByMaxChars,
    redactionCount: rendered.redactionCount,
    maskedPlaceholderCount: rendered.maskedPlaceholderCount,
    excerptCount: rendered.excerpts.length,
  });

  return {
    excerpts: rendered.excerpts,
    matchedMarkers: [...markers].slice(0, 12),
    totalLines,
    analyzedLines,
    omittedLines,
    truncatedByMaxChars: rendered.truncatedByMaxChars,
    redactionCount: rendered.redactionCount,
    redactionCategories: [...rendered.redactionCategories],
    maskedPlaceholderCount: rendered.maskedPlaceholderCount,
    hasFailureMarkers,
    notes,
  };
}

function buildSegments(lines: readonly string[]): Segment[] {
  if (lines.length <= MAX_ANALYZED_LINES) {
    return [{ offset: 0, lines }];
  }
  const headCount = HEAD_LINES_WHEN_SAMPLING;
  const tailCount = MAX_ANALYZED_LINES - headCount;
  const tailStart = lines.length - tailCount;
  return [
    { offset: 0, lines: lines.slice(0, headCount) },
    { offset: tailStart, lines: lines.slice(tailStart) },
  ];
}

function groupSelectedLines(
  segmentIndex: number,
  selected: ReadonlySet<number>,
  lineScores: readonly number[],
  lineMarkers: readonly Set<string>[],
): Window[] {
  const indices = [...selected].sort((a, b) => a - b);
  const windows: Window[] = [];
  let start: number | null = null;
  let end: number | null = null;

  const flush = (): void => {
    if (start === null || end === null) return;
    let score = 0;
    let hitCount = 0;
    const windowMarkers = new Set<string>();
    for (let index = start; index <= end; index += 1) {
      score += lineScores[index] ?? 0;
      if ((lineScores[index] ?? 0) > 0) hitCount += 1;
      for (const marker of lineMarkers[index] ?? []) windowMarkers.add(marker);
    }
    windows.push({ segmentIndex, start, end, score, hitCount, markers: windowMarkers });
  };

  for (const index of indices) {
    if (start === null || end === null) {
      start = index;
      end = index;
    } else if (index === end + 1) {
      end = index;
    } else {
      flush();
      start = index;
      end = index;
    }
  }
  flush();
  return windows;
}

function selectWindows(windows: readonly Window[], maxExcerpts: number): Window[] {
  return [...windows]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.hitCount !== a.hitCount) return b.hitCount - a.hitCount;
      // Prefer later regions when scores tie: failures are usually at the end.
      return b.start - a.start;
    })
    .slice(0, maxExcerpts)
    .sort((a, b) => a.segmentIndex - b.segmentIndex || a.start - b.start);
}

interface RenderedExcerpts {
  excerpts: LogExcerpt[];
  truncatedByMaxChars: boolean;
  redactionCount: number;
  redactionCategories: string[];
  maskedPlaceholderCount: number;
}

function renderWindows(
  windows: readonly Window[],
  segments: readonly Segment[],
  maxChars: number,
  extraPatterns: readonly RegExp[] | undefined,
): RenderedExcerpts {
  const redactionCategories = new Set<string>();
  let redactionCount = 0;
  let maskedPlaceholderCount = 0;
  let used = 0;
  let truncatedByMaxChars = false;
  const excerpts: LogExcerpt[] = [];

  if (maxChars <= 0) {
    return {
      excerpts,
      truncatedByMaxChars: windows.length > 0,
      redactionCount: 0,
      redactionCategories: [],
      maskedPlaceholderCount: 0,
    };
  }

  for (const window of windows) {
    const remaining = maxChars - used - (excerpts.length > 0 ? GROUP_SEPARATOR.length : 0);
    if (remaining <= 40) {
      truncatedByMaxChars = true;
      break;
    }
    const segment = segments[window.segmentIndex];
    if (segment === undefined) continue;

    const startLineNumber = segment.offset + window.start;
    const endLineNumber = segment.offset + window.end;
    const width = Math.max(3, String(endLineNumber + 1).length);
    const budget = Math.min(
      remaining,
      Math.max(200, Math.floor(maxChars / Math.max(1, windows.length))),
    );
    const renderedLines: string[] = [];
    const markers = new Set<string>();
    let lineBudget = budget;
    let cut = false;
    let lastRenderedIndex = window.start - 1;

    for (let index = window.start; index <= window.end; index += 1) {
      const rawLine = segment.lines[index] ?? "";
      const redacted = redactSecrets(rawLine, {
        extraPatterns,
      });
      redactionCount += redacted.redactionCount;
      for (const category of redacted.categories) redactionCategories.add(category);
      maskedPlaceholderCount += redacted.maskedPlaceholderCount;

      for (const signal of matchSignals(rawLine)) markers.add(signal.category);
      const prefix = `${String(segment.offset + index + 1).padStart(width)} | `;
      let content = redacted.text;
      const available = lineBudget - prefix.length - 1;
      if (available <= 0) {
        cut = true;
        break;
      }
      if (content.length > available) {
        content = truncateText(content, available, " …").text;
        cut = true;
      }
      const line = `${prefix}${content}`;
      if (line.length + 1 > lineBudget) {
        cut = true;
        break;
      }
      renderedLines.push(line);
      lastRenderedIndex = index;
      lineBudget -= line.length + 1;
      if (cut) break;
    }

    if (renderedLines.length === 0) {
      truncatedByMaxChars = true;
      break;
    }

    let text = renderedLines.join("\n");
    if (cut) {
      const omitted = window.end - lastRenderedIndex;
      const suffix = `\n[... ${Math.max(0, omitted)} more line(s) in this region omitted ...]`;
      if (text.length + suffix.length <= budget) text += suffix;
      truncatedByMaxChars = true;
    }

    if (used + text.length + (excerpts.length > 0 ? GROUP_SEPARATOR.length : 0) > maxChars) {
      const fit = maxChars - used - (excerpts.length > 0 ? GROUP_SEPARATOR.length : 0);
      if (fit <= 0) {
        truncatedByMaxChars = true;
        break;
      }
      text = truncateText(text, fit, "\n[... excerpt truncated ...]").text;
      truncatedByMaxChars = true;
    }

    excerpts.push({
      startLine: startLineNumber + 1,
      // Report the last line actually included, not the whole selected window.
      endLine: segment.offset + Math.max(lastRenderedIndex, window.start) + 1,
      text,
      markers: [...markers].slice(0, 8),
    });
    used += text.length + (excerpts.length > 1 ? GROUP_SEPARATOR.length : 0);
  }

  return {
    excerpts,
    truncatedByMaxChars,
    redactionCount,
    redactionCategories: [...redactionCategories].sort(),
    maskedPlaceholderCount,
  };
}

interface NoteInput {
  totalLines: number;
  omittedLines: number;
  hasFailureMarkers: boolean;
  truncatedBySize: boolean;
  truncatedByMaxChars: boolean;
  redactionCount: number;
  maskedPlaceholderCount: number;
  excerptCount: number;
}

function buildNotes(input: NoteInput): string[] {
  const notes: string[] = [];
  if (input.truncatedBySize) {
    notes.push(
      "The log download exceeded the server's safety cap. The beginning and end were kept, so excerpts from the middle may be missing.",
    );
  }
  if (input.omittedLines > 0) {
    notes.push(
      `${input.omittedLines} of ${input.totalLines} log lines were not scanned to bound response time. Line numbers in excerpts refer to the original log.`,
    );
  }
  if (!input.hasFailureMarkers) {
    notes.push(
      "No recognizable failure markers were found. Fallback context is shown from the beginning and/or end of the log; the full log may still contain the cause.",
    );
  }
  if (input.truncatedByMaxChars) {
    notes.push(
      "Excerpt text was truncated to respect maxChars. Request a larger maxChars (subject to the server's hard cap) for more context.",
    );
  }
  if (input.redactionCount > 0) {
    notes.push(
      `Redaction replaced ${input.redactionCount} secret-like value(s). ${REDACTION_DISCLAIMER}`,
    );
  }
  if (input.maskedPlaceholderCount > 0) {
    notes.push(
      "GitHub-masked placeholders (***) are present. They may still indicate where sensitive values appeared.",
    );
  }
  if (input.excerptCount === 0) {
    notes.push("No excerpts could be produced within the requested size limit.");
  }
  return notes;
}

export { GROUP_SEPARATOR };
