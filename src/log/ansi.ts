/**
 * Normalize untrusted GitHub Actions log text for safe display.
 * ANSI/OSC escape sequences and most control characters are removed.
 */
/* eslint-disable no-control-regex -- matching control characters is this module's purpose */
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_OTHER = /\u001b[@-Z\\-_]/g;
// Keep tab (\t, \u0009) and newline (\n, \u000a); strip other C0 controls and DEL.
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
// Raw Actions logs prefix each line with an ISO-8601 timestamp.
const TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s?/;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(ANSI_OTHER, "");
}

export function normalizeLogText(input: string): string {
  return stripAnsi(input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n")).replace(CONTROL_CHARS, "");
}

export function stripLogLinePrefix(line: string): string {
  return line.replace(TIMESTAMP_PREFIX, "");
}

export function splitLogLines(input: string): string[] {
  const normalized = normalizeLogText(input);
  if (normalized.trim() === "") return [];
  return normalized.split("\n").map(stripLogLinePrefix);
}
