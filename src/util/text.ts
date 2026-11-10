export function truncateText(
  text: string,
  maxChars: number,
  marker = "\n[... truncated ...]",
): { text: string; truncated: boolean } {
  if (maxChars <= 0) return { text: "", truncated: text.length > 0 };
  if (text.length <= maxChars) return { text, truncated: false };
  const suffix = marker.length < maxChars ? marker : "";
  const keep = Math.max(0, maxChars - suffix.length);
  return { text: `${text.slice(0, keep)}${suffix}`, truncated: true };
}

export function shortSha(sha: string | null | undefined): string | null {
  return typeof sha === "string" && sha.length >= 7 ? sha.slice(0, 7) : null;
}

export function durationSeconds(
  start: string | null | undefined,
  end: string | null | undefined,
): number | null {
  if (!start || !end) return null;
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs < startMs) return null;
  return Math.round((endMs - startMs) / 1000);
}

export function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** Normalize whitespace for short one-line observations. */
export function oneLine(text: string, maxChars = 300): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return truncateText(collapsed, maxChars).text;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
