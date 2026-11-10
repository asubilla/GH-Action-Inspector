import type * as NodeFs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectClients, type DetectionContext } from "../src/setup/detect.js";

// Absolute install locations live outside the temporary home; simulate their
// existence while delegating every other probe to the real filesystem.
const simulatedAbsolutePaths = new Set([
  "/Applications/Claude.app",
  "/Applications/Cursor.app",
  "/opt/Claude",
  "/usr/share/cursor",
  "/usr/share/windsurf",
  "/usr/bin/zed",
  "/opt/idea",
]);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    existsSync: (candidate: string) =>
      simulatedAbsolutePaths.has(candidate) || actual.existsSync(candidate),
  };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

async function tempHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "gh-action-inspector-detect-"));
  temporaryDirectories.push(directory);
  return directory;
}

function linuxContext(home: string, pathEntries = ""): DetectionContext {
  return {
    home,
    cwd: home,
    platform: "linux",
    env: { PATH: pathEntries },
  };
}

function darwinContext(home: string, pathEntries = ""): DetectionContext {
  return {
    home,
    cwd: home,
    platform: "darwin",
    env: { PATH: pathEntries },
  };
}

function windowsContext(
  home: string,
  pathEntries = "",
  env: NodeJS.ProcessEnv = {},
): DetectionContext {
  return {
    home,
    cwd: home,
    platform: "win32",
    env: { Path: pathEntries, ...env },
  };
}

async function fakeExecutable(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), "", { mode: 0o755 });
}

async function fakeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
}

function detectionMap(detections: ReturnType<typeof detectClients>) {
  return new Map(detections.map((detection) => [detection.client.id, detection]));
}

describe("client detection", () => {
  it("detects clients from PATH markers, config directories, and extensions", async () => {
    const home = await tempHome();
    const bin = path.join(home, "bin");
    await fakeExecutable(bin, "cursor");
    await mkdir(path.join(home, ".cursor"), { recursive: true });
    await writeFile(path.join(home, ".cursor", "mcp.json"), "{}\n", "utf8");
    await mkdir(path.join(home, ".vscode-insiders", "extensions", "saoudrizwan.claude-dev-3.1.0"), {
      recursive: true,
    });
    await mkdir(path.join(home, ".continue"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });

    const detections = detectClients(linuxContext(home, bin));
    const byId = new Map(detections.map((detection) => [detection.client.id, detection]));

    expect(byId.get("cursor")?.installed).toBe(true);
    expect(byId.get("cursor")?.configExists).toBe(true);
    expect(byId.get("cursor")?.evidence.join(" ")).toContain('command "cursor" on PATH');
    expect(byId.get("claude-code")?.installed).toBe(false);
    expect(byId.get("cline")?.installed).toBe(true);
    expect(byId.get("continue")?.installed).toBe(true);
    expect(byId.get("codex")?.installed).toBe(true);
    expect(byId.get("vscode")?.installed).toBe(false);
    expect(byId.get("generic")?.installed).toBe(false);
  });

  it("detects macOS application data, extension folders, and colon-separated PATH entries", async () => {
    const home = await tempHome();
    const bin = path.join(home, "bin");
    const library = path.join(home, "Library", "Application Support");
    const vsCodeExtensions = path.join(home, ".vscode", "extensions");
    const windsurfExtensions = path.join(home, ".windsurf", "extensions");

    await fakeDirectory(path.join(library, "Claude"));
    await fakeDirectory(path.join(home, ".cursor"));
    await fakeDirectory(path.join(vsCodeExtensions, "saoudrizwan.claude-dev-3.1.0"));
    await fakeDirectory(path.join(windsurfExtensions, "continue.continue-1.2.3"));
    await fakeDirectory(path.join(home, ".config", "zed"));
    await fakeDirectory(path.join(home, "AppData", "Roaming", "JetBrains"));
    await fakeExecutable(bin, "code");
    await fakeExecutable(bin, "windsurf");

    const byId = detectionMap(
      detectClients(darwinContext(home, `${path.join(home, "missing-bin")}:${bin}`)),
    );

    expect(byId.get("claude-desktop")?.installed).toBe(true);
    expect(byId.get("claude-desktop")?.evidence.join(" ")).toContain(path.join(library, "Claude"));
    expect(byId.get("claude-desktop")?.evidence.join(" ")).toContain("/Applications/Claude.app");
    expect(byId.get("cursor")?.installed).toBe(true);
    expect(byId.get("cursor")?.evidence.join(" ")).toContain("/Applications/Cursor.app");
    expect(byId.get("vscode")?.installed).toBe(true);
    expect(byId.get("vscode")?.evidence.join(" ")).toContain('command "code" on PATH');
    expect(byId.get("cline")?.installed).toBe(true);
    expect(byId.get("cline")?.evidence.join(" ")).toContain("Cline extension");
    expect(byId.get("continue")?.installed).toBe(true);
    expect(byId.get("continue")?.evidence.join(" ")).toContain("Continue extension");
    expect(byId.get("zed")?.installed).toBe(true);
    expect(byId.get("windsurf")?.installed).toBe(true);
    expect(byId.get("windsurf")?.evidence.join(" ")).toContain('command "windsurf" on PATH');

    // Windows-only application data must not count as macOS evidence.
    expect(byId.get("jetbrains")?.installed).toBe(false);
  });

  it("detects Linux distribution install locations", async () => {
    const home = await tempHome();
    const byId = detectionMap(detectClients(linuxContext(home)));

    expect(byId.get("claude-desktop")?.evidence.join(" ")).toContain("/opt/Claude");
    expect(byId.get("cursor")?.evidence.join(" ")).toContain("/usr/share/cursor");
    expect(byId.get("windsurf")?.evidence.join(" ")).toContain("/usr/share/windsurf");
    expect(byId.get("zed")?.evidence.join(" ")).toContain("/usr/bin/zed");
    expect(byId.get("jetbrains")?.evidence.join(" ")).toContain("/opt/idea");
  });

  it("detects Linux home and XDG install locations", async () => {
    const home = await tempHome();
    const bin = path.join(home, "bin");

    await fakeDirectory(path.join(home, ".config", "Claude"));
    await fakeDirectory(path.join(home, ".cursor"));
    await fakeDirectory(path.join(home, ".vscode", "extensions", "continue.continue-1.3.0"));
    await fakeDirectory(path.join(home, ".codeium", "windsurf"));
    await fakeDirectory(path.join(home, ".config", "zed"));
    await fakeDirectory(path.join(home, ".claude"));
    await fakeDirectory(path.join(home, ".continue"));
    await fakeDirectory(path.join(home, ".codex"));
    await fakeExecutable(bin, "windsurf");

    const byId = detectionMap(detectClients(linuxContext(home, bin)));

    expect(byId.get("claude-desktop")?.evidence.join(" ")).toContain(
      path.join(home, ".config", "Claude"),
    );
    expect(byId.get("cursor")?.installed).toBe(true);
    expect(byId.get("vscode")?.installed).toBe(true);
    expect(byId.get("windsurf")?.installed).toBe(true);
    expect(byId.get("zed")?.installed).toBe(true);
    expect(byId.get("claude-code")?.installed).toBe(true);
    expect(byId.get("continue")?.installed).toBe(true);
    expect(byId.get("codex")?.installed).toBe(true);
    expect(byId.get("continue")?.evidence.join(" ")).toContain("Continue extension");
  });

  it("detects Windows application data, extension folders, and executable PATH entries", async () => {
    const home = await tempHome();
    const localAppData = path.join(home, "LocalData");
    const roamingAppData = path.join(home, "RoamingData");
    const tools = path.join(home, "Tools");
    const otherBin = path.join(home, "other bin");

    await fakeDirectory(path.join(localAppData, "AnthropicClaude"));
    await fakeDirectory(path.join(localAppData, "Programs", "Microsoft VS Code"));
    await fakeDirectory(path.join(localAppData, "Programs", "Windsurf"));
    await fakeDirectory(path.join(roamingAppData, "Zed"));
    await fakeDirectory(path.join(roamingAppData, "JetBrains"));
    await fakeDirectory(path.join(home, ".cursor", "extensions", "continue.continue-1.0.0"));
    await fakeDirectory(path.join(home, ".vscode", "extensions", "saoudrizwan.claude-dev-3.0.0"));
    await fakeExecutable(tools, "cursor.cmd");
    await fakeExecutable(tools, "claude.exe");
    await fakeExecutable(otherBin, "codex.bat");
    await fakeDirectory(path.join(home, ".cursor"));
    await writeFile(path.join(home, ".cursor", "mcp.json"), "{}\n", "utf8");

    const byId = detectionMap(
      detectClients(
        windowsContext(home, `"${tools}";${otherBin};${path.join(home, "missing-bin")};`, {
          LOCALAPPDATA: localAppData,
          APPDATA: roamingAppData,
        }),
      ),
    );

    expect(byId.get("claude-desktop")?.installed).toBe(true);
    expect(byId.get("claude-desktop")?.evidence.join(" ")).toContain("AnthropicClaude");
    expect(byId.get("cursor")?.installed).toBe(true);
    expect(byId.get("cursor")?.configExists).toBe(true);
    expect(byId.get("cursor")?.evidence.join(" ")).toContain("cursor.cmd");
    expect(byId.get("vscode")?.installed).toBe(true);
    expect(byId.get("windsurf")?.installed).toBe(true);
    expect(byId.get("windsurf")?.evidence.join(" ")).toContain(
      path.join(localAppData, "Programs", "Windsurf"),
    );
    expect(byId.get("zed")?.installed).toBe(true);
    expect(byId.get("jetbrains")?.installed).toBe(true);
    expect(byId.get("jetbrains")?.evidence.join(" ")).toContain(
      path.join(roamingAppData, "JetBrains"),
    );
    expect(byId.get("claude-code")?.installed).toBe(true);
    expect(byId.get("claude-code")?.evidence.join(" ")).toContain("claude.exe");
    expect(byId.get("codex")?.installed).toBe(true);
    expect(byId.get("codex")?.evidence.join(" ")).toContain("codex.bat");
    expect(byId.get("cline")?.installed).toBe(true);
    expect(byId.get("continue")?.installed).toBe(true);
  });

  it("falls back to AppData under home when Windows environment variables are absent", async () => {
    const home = await tempHome();

    await fakeDirectory(path.join(home, "AppData", "Local", "AnthropicClaude"));
    await fakeDirectory(path.join(home, "AppData", "Local", "Programs", "Microsoft VS Code"));
    await fakeDirectory(path.join(home, "AppData", "Roaming", "JetBrains"));

    const byId = detectionMap(detectClients(windowsContext(home)));

    expect(byId.get("claude-desktop")?.installed).toBe(true);
    expect(byId.get("vscode")?.installed).toBe(true);
    expect(byId.get("jetbrains")?.installed).toBe(true);
  });

  const toolboxLayouts: ReadonlyArray<{
    platform: NodeJS.Platform;
    segments: readonly string[];
    context: (home: string) => DetectionContext;
  }> = [
    {
      platform: "linux",
      segments: [".local", "share", "JetBrains", "Toolbox"],
      context: linuxContext,
    },
    {
      platform: "darwin",
      segments: ["Library", "Application Support", "JetBrains", "Toolbox"],
      context: darwinContext,
    },
    {
      platform: "win32",
      segments: ["AppData", "Local", "JetBrains", "Toolbox"],
      context: windowsContext,
    },
  ];

  it.each(toolboxLayouts)(
    "recognizes the $platform JetBrains Toolbox layout",
    async ({ segments, context }) => {
      const home = await tempHome();
      const toolbox = path.join(home, ...segments);
      const jetbrainsRoot = path.join(home, ...segments.slice(0, -1));
      await fakeDirectory(
        path.join(toolbox, "apps", "IDEA-U", "ch-0", "243.21565.193", "IntelliJ IDEA.app"),
      );

      const jetbrains = detectionMap(detectClients(context(home))).get("jetbrains");

      expect(jetbrains?.installed).toBe(true);
      expect(jetbrains?.evidence.join(" ")).toContain(jetbrainsRoot);
    },
  );

  it("does not read config contents while detecting", async () => {
    const home = await tempHome();
    const configPath = path.join(home, ".cursor", "mcp.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{"mcpServers":{"x":{"env":{"GITHUB_TOKEN":"not-a-real-token"}}}}');

    const detections = detectClients(linuxContext(home));
    const cursor = detections.find((detection) => detection.client.id === "cursor");

    expect(cursor?.configExists).toBe(true);
    expect(cursor?.evidence.join(" ")).not.toContain("not-a-real-token");
  });
});
