import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getClientSetup } from "../src/setup/clients.js";
import { runSetupCommand } from "../src/setup/command.js";
import type { ClientDetection, DetectionContext } from "../src/setup/detect.js";
import { formatDetectionJson, formatDetectionReport } from "../src/setup/report.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

async function tempHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "gh-action-inspector-report-"));
  temporaryDirectories.push(directory);
  return directory;
}

function linuxContext(home: string): DetectionContext {
  return {
    home,
    cwd: home,
    platform: "linux",
    env: { PATH: "" },
  };
}

function capturedOutput(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call) => String(call[0])).join("");
}

function sampleDetections(): ClientDetection[] {
  const cursor = getClientSetup("cursor");
  const claudeCode = getClientSetup("claude-code");
  if (cursor === undefined || claudeCode === undefined) {
    throw new Error("expected setup catalog entries");
  }

  return [
    {
      client: cursor,
      installed: true,
      evidence: [
        'command "cursor" on PATH: /usr/local/bin/cursor',
        "existing config: /home/a/.cursor/mcp.json",
      ],
      configPath: "/home/a/.cursor/mcp.json",
      configExists: true,
    },
    {
      client: claudeCode,
      installed: false,
      evidence: [],
      configPath: null,
      configExists: false,
    },
  ];
}

describe("client detection report", () => {
  it("renders detected status, all evidence, and a no-write notice", () => {
    const report = formatDetectionReport(sampleDetections());

    expect(report).toContain("GH Action Inspector detection report (1/2 detected)");
    expect(report).toContain("detected");
    expect(report).toContain("Cursor (cursor)");
    expect(report).toContain('command "cursor" on PATH: /usr/local/bin/cursor');
    expect(report).toContain("existing config: /home/a/.cursor/mcp.json");
    expect(report).toContain("not detected");
    expect(report).toContain("Claude Code (claude-code)");
    expect(report).toContain("no evidence found");
    expect(report).toContain("No configuration files were written.");
    expect(report).not.toContain("GITHUB_TOKEN");
  });

  it("serializes the report as stable JSON", () => {
    const parsed = JSON.parse(formatDetectionJson(sampleDetections())) as {
      mode: string;
      readOnly: boolean;
      detected: number;
      total: number;
      clients: Array<Record<string, unknown>>;
    };

    expect(parsed.mode).toBe("detection");
    expect(parsed.readOnly).toBe(true);
    expect(parsed.detected).toBe(1);
    expect(parsed.total).toBe(2);
    expect(parsed.clients[0]).toMatchObject({
      id: "cursor",
      name: "Cursor",
      detected: true,
      evidence: [
        'command "cursor" on PATH: /usr/local/bin/cursor',
        "existing config: /home/a/.cursor/mcp.json",
      ],
      configPath: "/home/a/.cursor/mcp.json",
      configExists: true,
    });
    expect(parsed.clients[1]).toMatchObject({
      id: "claude-code",
      detected: false,
      evidence: [],
      configPath: null,
      configExists: false,
    });
  });

  it("prints the report through setup --detect without creating configs", async () => {
    const home = await tempHome();
    await mkdir(path.join(home, ".cursor"), { recursive: true });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await runSetupCommand(["--detect"], linuxContext(home));
    const output = capturedOutput(stdout);

    expect(code).toBe(0);
    expect(output).toContain("GH Action Inspector detection report");
    expect(output).toContain("Cursor (cursor)");
    expect(output).toContain(path.join(home, ".cursor"));
    expect(output).toContain("No configuration files were written.");
    await expect(stat(path.join(home, ".cursor", "mcp.json"))).rejects.toThrow();
  });

  it("prints JSON through setup --detect --json", async () => {
    const home = await tempHome();
    await mkdir(path.join(home, ".cursor"), { recursive: true });
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const code = await runSetupCommand(["--detect", "--json"], linuxContext(home));
    const parsed = JSON.parse(capturedOutput(stdout)) as {
      readOnly: boolean;
      clients: Array<{ id: string; detected: boolean }>;
    };

    expect(code).toBe(0);
    expect(parsed.readOnly).toBe(true);
    expect(parsed.clients.find((client) => client.id === "cursor")?.detected).toBe(true);
    await expect(stat(path.join(home, ".cursor", "mcp.json"))).rejects.toThrow();
  });

  it("requires --detect when --json is used", async () => {
    const home = await tempHome();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await runSetupCommand(["--json"], linuxContext(home));

    expect(code).toBe(1);
    expect(capturedOutput(stderr)).toBe("--json requires --detect.\n");
  });

  it("rejects combining --detect with configuration flags", async () => {
    const home = await tempHome();
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const code = await runSetupCommand(["--detect", "--write"], linuxContext(home));

    expect(code).toBe(1);
    expect(capturedOutput(stdout)).toBe("");
    expect(capturedOutput(stderr)).toContain(
      "--detect cannot be combined with --client, --write, or --interactive.",
    );
  });
});
