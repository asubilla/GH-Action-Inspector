import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT_SETUPS,
  createJsonEntry,
  defaultLaunch,
  getClientSetup,
  TOKEN_PLACEHOLDER,
  type SetupOptions,
} from "../src/setup/clients.js";
import { writeClientConfig } from "../src/setup/write-config.js";

const setupOptions: SetupOptions = {
  launch: { command: "npx", args: ["-y", "gh-action-inspector@latest"] },
  tokenPlaceholder: TOKEN_PLACEHOLDER,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

async function tempHome(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "gh-action-inspector-setup-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("client setup helpers", () => {
  it("uses npx by default and the local build with --local", () => {
    expect(defaultLaunch(false)).toEqual({
      command: "npx",
      args: ["-y", "gh-action-inspector@latest"],
    });
    const local = defaultLaunch(true);
    expect(local.command).toBe(process.execPath);
    expect(local.args[0]).toMatch(/dist[/\\]cli\.js$/);
  });

  it("generates valid JSON snippets with a token placeholder only", () => {
    const jsonClients = CLIENT_SETUPS.filter((client) => client.configKind === "json");
    expect(jsonClients.length).toBeGreaterThan(0);
    for (const client of jsonClients) {
      const snippet = client.snippet(setupOptions);
      const parsed: unknown = JSON.parse(snippet);
      expect(parsed).toBeTypeOf("object");
      expect(snippet).toContain(TOKEN_PLACEHOLDER);
      expect(snippet).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    }
  });

  it("uses the correct entry shape per client", () => {
    const generic = createJsonEntry("generic", setupOptions);
    expect(generic.type).toBeUndefined();
    expect(generic.env).toEqual({ GITHUB_TOKEN: TOKEN_PLACEHOLDER });

    const vscode = createJsonEntry("vscode", setupOptions);
    expect(vscode.type).toBe("stdio");

    const zed = createJsonEntry("zed", setupOptions);
    expect(zed.source).toBe("custom");
  });

  it("prints commands and TOML/YAML snippets for non-JSON clients", () => {
    const claudeCode = getClientSetup("claude-code");
    expect(claudeCode?.snippet(setupOptions)).toContain("claude mcp add");
    const codex = getClientSetup("codex");
    expect(codex?.snippet(setupOptions)).toContain("[mcp_servers.gh-action-inspector]");
    const continueClient = getClientSetup("continue");
    expect(continueClient?.snippet(setupOptions)).toContain("mcpServers:");
  });

  it("writes a merged config with owner-only permissions and a backup", async () => {
    const home = await tempHome();
    const cursor = getClientSetup("cursor");
    if (cursor === undefined) throw new Error("cursor setup missing");
    const configPath = path.join(home, ".cursor", "mcp.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ mcpServers: { existing: { command: "node", args: ["keep.js"] } } }),
      "utf8",
    );
    await chmod(configPath, 0o644);

    const first = await writeClientConfig(cursor, setupOptions, { home, cwd: home });
    expect(first.created).toBe(false);
    expect(first.backupPath).not.toBeNull();

    const parsed = JSON.parse(await readFile(configPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers.existing).toEqual({ command: "node", args: ["keep.js"] });
    expect(parsed.mcpServers["gh-action-inspector"]).toEqual({
      command: "npx",
      args: ["-y", "gh-action-inspector@latest"],
      env: { GITHUB_TOKEN: TOKEN_PLACEHOLDER },
    });
    const mode = (await stat(configPath)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(await readFile(first.backupPath ?? "", "utf8")).toContain("existing");
  });

  it("creates a new config file when none exists", async () => {
    const home = await tempHome();
    const windsurf = getClientSetup("windsurf");
    if (windsurf === undefined) throw new Error("windsurf setup missing");
    const result = await writeClientConfig(windsurf, setupOptions, { home, cwd: home });
    expect(result.created).toBe(true);
    expect(result.backupPath).toBeNull();
    const parsed = JSON.parse(await readFile(result.path, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers["gh-action-inspector"]).toBeDefined();
  });

  it("refuses to overwrite invalid JSON or a non-object bucket", async () => {
    const home = await tempHome();
    const cursor = getClientSetup("cursor");
    if (cursor === undefined) throw new Error("cursor setup missing");
    const configPath = path.join(home, ".cursor", "mcp.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, "{ // comments are not valid JSON\n}", "utf8");
    await expect(writeClientConfig(cursor, setupOptions, { home, cwd: home })).rejects.toThrow(
      /not strict JSON/,
    );

    await writeFile(configPath, JSON.stringify({ mcpServers: [] }), "utf8");
    await expect(writeClientConfig(cursor, setupOptions, { home, cwd: home })).rejects.toThrow(
      /not an object/,
    );
  });
});
