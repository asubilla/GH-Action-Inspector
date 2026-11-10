import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { detectClients } from "../src/setup/detect.js";
import { runSetupWizard } from "../src/setup/wizard.js";

const launch = {
  command: "npx",
  args: ["-y", "gh-action-inspector@latest"],
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

async function tempHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "gh-action-inspector-wizard-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function fakeExecutable(directory: string, name: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, name), "", { mode: 0o755 });
}

function detectionFor(home: string, pathEntries = "") {
  return detectClients({
    home,
    cwd: home,
    platform: "linux",
    env: { PATH: pathEntries },
  });
}

function clientNumber(home: string, id: string, pathEntries = ""): number {
  const index = detectionFor(home, pathEntries).findIndex((item) => item.client.id === id);
  if (index < 0) throw new Error(`client ${id} missing from catalog`);
  return index + 1;
}

async function runWizard(
  lines: readonly string[],
  home: string,
  pathEntries = "",
): Promise<{ output: string; result: Awaited<ReturnType<typeof runSetupWizard>> }> {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk: Buffer) => {
    text += chunk.toString();
  });

  const promise = runSetupWizard({
    input,
    output,
    context: { home, cwd: home, platform: "linux", env: { PATH: pathEntries } },
    launch,
  });
  for (const line of lines) input.write(`${line}\n`);
  input.end();

  const result = await promise;
  return { output: text, result };
}

describe("interactive setup wizard", () => {
  it("writes only the selected client configuration", async () => {
    const home = await tempHome();
    await mkdir(path.join(home, ".cursor"), { recursive: true });
    await mkdir(path.join(home, ".codeium", "windsurf"), { recursive: true });

    const { output, result } = await runWizard([String(clientNumber(home, "cursor")), "1"], home);

    expect(result.cancelled).toBe(false);
    expect(result.installed).toEqual(["cursor"]);
    expect(result.printed).toEqual([]);
    expect(result.failed).toEqual([]);

    const configPath = path.join(home, ".cursor", "mcp.json");
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers: Record<string, { env: { GITHUB_TOKEN: string } }>;
    };
    expect(parsed.mcpServers["gh-action-inspector"]?.env.GITHUB_TOKEN).toBe("<YOUR_GITHUB_TOKEN>");
    expect((await stat(configPath)).mode & 0o777).toBe(0o600);
    await expect(
      stat(path.join(home, ".codeium", "windsurf", "mcp_config.json")),
    ).rejects.toThrow();

    expect(output).toContain("Detected MCP clients");
    expect(output).toContain("Windsurf");
    expect(output).not.toContain("not-a-real-token");
  });

  it("selects detected clients by default without touching undetected ones", async () => {
    const home = await tempHome();
    await mkdir(path.join(home, ".cursor"), { recursive: true });
    await mkdir(path.join(home, ".codeium", "windsurf"), { recursive: true });

    const { result } = await runWizard(["", "1"], home);
    expect(result.installed).toEqual(["cursor", "windsurf"]);
    await expect(stat(path.join(home, ".config", "zed", "settings.json"))).rejects.toThrow();
  });

  it("prints snippets without writing when print-only is selected", async () => {
    const home = await tempHome();
    await mkdir(path.join(home, ".cursor"), { recursive: true });

    const { output, result } = await runWizard([String(clientNumber(home, "cursor")), "2"], home);

    expect(result.installed).toEqual([]);
    expect(result.printed).toEqual(["cursor"]);
    expect(output).toContain('"gh-action-inspector"');
    await expect(stat(path.join(home, ".cursor", "mcp.json"))).rejects.toThrow();
  });

  it("prints UI-managed client instructions instead of writing a file", async () => {
    const home = await tempHome();
    const bin = path.join(home, "bin");
    await fakeExecutable(bin, "claude");

    const { output, result } = await runWizard(
      [String(clientNumber(home, "claude-code", bin)), "1"],
      home,
      bin,
    );

    expect(result.installed).toEqual([]);
    expect(result.printed).toEqual(["claude-code"]);
    expect(output).toContain("claude mcp add");
    expect(output).toContain("configured through its UI or CLI");
  });

  it("cancels cleanly and writes nothing on quit", async () => {
    const home = await tempHome();
    await mkdir(path.join(home, ".cursor"), { recursive: true });

    const { result } = await runWizard(["q"], home);
    expect(result.cancelled).toBe(true);
    expect(result.installed).toEqual([]);
    expect(result.printed).toEqual([]);
    await expect(stat(path.join(home, ".cursor", "mcp.json"))).rejects.toThrow();
  });

  it("re-prompts after an invalid selection", async () => {
    const home = await tempHome();
    await mkdir(path.join(home, ".cursor"), { recursive: true });

    const { output, result } = await runWizard(["99", "q"], home);
    expect(output).toContain("Enter numbers 1-");
    expect(result.cancelled).toBe(true);
  });
});
