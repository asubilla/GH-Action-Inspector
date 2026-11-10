import type { ClientId } from "./clients.js";
import type { ClientDetection } from "./detect.js";

export interface ClientDetectionJson {
  id: ClientId;
  name: string;
  detected: boolean;
  evidence: string[];
  configPath: string | null;
  configExists: boolean;
}

export interface DetectionJson {
  detected: number;
  total: number;
  clients: ClientDetectionJson[];
}

/** Convert detections to the stable JSON shape used by setup and doctor. */
export function detectionJson(detections: readonly ClientDetection[]): DetectionJson {
  return {
    detected: detections.filter((detection) => detection.installed).length,
    total: detections.length,
    clients: detections.map((detection) => ({
      id: detection.client.id,
      name: detection.client.name,
      detected: detection.installed,
      evidence: [...detection.evidence],
      configPath: detection.configPath,
      configExists: detection.configExists,
    })),
  };
}

/** Render the machine-readable, read-only detection report. */
export function formatDetectionJson(detections: readonly ClientDetection[]): string {
  return `${JSON.stringify(
    { mode: "detection", readOnly: true, ...detectionJson(detections) },
    null,
    2,
  )}\n`;
}

/**
 * Render a read-only detection report. Detection only checks path existence;
 * this formatter never reads configuration contents or writes any files.
 */
export function formatDetectionReport(detections: readonly ClientDetection[]): string {
  const detectedCount = detections.filter((detection) => detection.installed).length;
  const lines = [
    `GH Action Inspector detection report (${detectedCount}/${detections.length} detected)`,
    "",
    "Checked application paths, config directories, extension folders, and PATH entries.",
    "Configuration contents were not read.",
    "",
  ];

  for (const detection of detections) {
    const status = detection.installed ? "detected" : "not detected";
    lines.push(`  ${status.padEnd(13)} ${detection.client.name} (${detection.client.id})`);
    if (detection.evidence.length === 0) {
      lines.push("                no evidence found");
      continue;
    }
    for (const evidence of detection.evidence) {
      lines.push(`                - ${evidence}`);
    }
  }

  lines.push(
    "",
    "No configuration files were written.",
    "Run `gh-action-inspector setup` to choose clients and install or print their configuration.",
    "",
  );
  return lines.join("\n");
}
