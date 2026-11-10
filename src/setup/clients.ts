import path from "node:path";

export const MCP_SERVER_KEY = "gh-action-inspector";

export type ClientId =
  | "claude-desktop"
  | "claude-code"
  | "cursor"
  | "vscode"
  | "windsurf"
  | "zed"
  | "cline"
  | "jetbrains"
  | "continue"
  | "codex"
  | "generic";

export type ConfigKind = "json" | "toml" | "yaml" | "command" | "manual";

export interface LaunchConfig {
  command: string;
  args: string[];
}

export interface SetupOptions {
  launch: LaunchConfig;
  tokenPlaceholder: string;
}

export interface PathContext {
  home: string;
  cwd: string;
}

export interface ClientSetup {
  id: ClientId;
  name: string;
  configKind: ConfigKind;
  /** JSON merge key for writable clients. */
  mergeKey?: "mcpServers" | "servers" | "context_servers";
  /** Path helper; null when the client is configured through its UI or CLI. */
  resolvePath?: (context: PathContext) => string | null;
  /** Whether `--write` is supported and verified for this client. */
  writable: boolean;
  snippet: (options: SetupOptions) => string;
  notes: string[];
}

const PACKAGE = "gh-action-inspector";

export function defaultLaunch(useLocal: boolean): LaunchConfig {
  if (useLocal) {
    return {
      command: process.execPath,
      args: [path.resolve(process.cwd(), "dist", "cli.js")],
    };
  }
  return { command: "npx", args: ["-y", `${PACKAGE}@latest`] };
}

export const TOKEN_PLACEHOLDER = "<YOUR_GITHUB_TOKEN>";

export function createJsonEntry(id: ClientId, options: SetupOptions): Record<string, unknown> {
  const base = {
    command: options.launch.command,
    args: options.launch.args,
    env: { GITHUB_TOKEN: options.tokenPlaceholder },
  };
  if (id === "vscode") return { type: "stdio", ...base };
  if (id === "zed") return { source: "custom", ...base };
  return base;
}

export function jsonServerConfig(options: SetupOptions): string {
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_KEY]: createJsonEntry("generic", options) } },
    null,
    2,
  );
}

function jsonSnippet(mergeKey: string, id: ClientId = "generic") {
  return (options: SetupOptions): string =>
    JSON.stringify({ [mergeKey]: { [MCP_SERVER_KEY]: createJsonEntry(id, options) } }, null, 2);
}

function shellArgs(values: readonly string[]): string {
  return values
    .map((value) =>
      /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`,
    )
    .join(" ");
}

export const CLIENT_SETUPS: readonly ClientSetup[] = [
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    configKind: "json",
    mergeKey: "mcpServers",
    writable: true,
    resolvePath: ({ home }) => {
      if (process.platform === "darwin") {
        return path.join(
          home,
          "Library",
          "Application Support",
          "Claude",
          "claude_desktop_config.json",
        );
      }
      if (process.platform === "win32") {
        return path.join(
          process.env.APPDATA ?? path.join(home, "AppData", "Roaming"),
          "Claude",
          "claude_desktop_config.json",
        );
      }
      return path.join(home, ".config", "Claude", "claude_desktop_config.json");
    },
    snippet: jsonSnippet("mcpServers"),
    notes: [
      "Merge into the existing mcpServers object; do not replace other servers.",
      "Quit and reopen Claude Desktop after editing the file.",
    ],
  },
  {
    id: "cursor",
    name: "Cursor",
    configKind: "json",
    mergeKey: "mcpServers",
    writable: true,
    resolvePath: ({ home }) => path.join(home, ".cursor", "mcp.json"),
    snippet: jsonSnippet("mcpServers"),
    notes: [
      "Cursor reads ~/.cursor/mcp.json. A project .cursor/mcp.json also works when you want per-project setup.",
      "Reload the MCP servers from Cursor Settings → MCP after editing.",
    ],
  },
  {
    id: "vscode",
    name: "VS Code (GitHub Copilot agent mode)",
    configKind: "json",
    mergeKey: "servers",
    writable: true,
    resolvePath: ({ cwd }) => path.join(cwd, ".vscode", "mcp.json"),
    snippet: jsonSnippet("servers", "vscode"),
    notes: [
      'VS Code uses a top-level servers object and type: "stdio".',
      "The default path is the current project's .vscode/mcp.json; add .vscode/mcp.json to .gitignore if it contains a token.",
      "Run 'MCP: List Servers' from the Command Palette to start it.",
    ],
  },
  {
    id: "windsurf",
    name: "Windsurf",
    configKind: "json",
    mergeKey: "mcpServers",
    writable: true,
    resolvePath: ({ home }) => path.join(home, ".codeium", "windsurf", "mcp_config.json"),
    snippet: jsonSnippet("mcpServers"),
    notes: ["Windsurf reads ~/.codeium/windsurf/mcp_config.json and needs a refresh after edits."],
  },
  {
    id: "zed",
    name: "Zed",
    configKind: "json",
    mergeKey: "context_servers",
    writable: true,
    resolvePath: ({ home }) => path.join(home, ".config", "zed", "settings.json"),
    snippet: jsonSnippet("context_servers", "zed"),
    notes: [
      'Zed uses a context_servers object with source: "custom".',
      "Merge this entry into your existing Zed settings.json.",
    ],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    configKind: "command",
    writable: false,
    snippet: (options) =>
      `claude mcp add --transport stdio ${MCP_SERVER_KEY} --env GITHUB_TOKEN=${TOKEN_PLACEHOLDER} -- ${shellArgs([options.launch.command, ...options.launch.args])}`,
    notes: [
      "Run the command in a terminal (replace the token placeholder first).",
      "Claude Code stores MCP configuration; no file editing is needed.",
    ],
  },
  {
    id: "cline",
    name: "Cline",
    configKind: "json",
    writable: false,
    snippet: jsonSnippet("mcpServers"),
    notes: [
      "Use Cline's MCP Servers panel → Configure MCP Servers to open cline_mcp_settings.json, then merge this entry.",
    ],
  },
  {
    id: "jetbrains",
    name: "JetBrains IDEs (AI Assistant / Junie)",
    configKind: "json",
    writable: false,
    snippet: jsonSnippet("mcpServers"),
    notes: [
      "Open Settings → Tools → AI Assistant → Model Context Protocol, add a stdio server, and paste the command/args.",
      "The JSON shape above matches clients that accept an mcpServers object; otherwise enter the command and arguments in the UI.",
    ],
  },
  {
    id: "continue",
    name: "Continue",
    configKind: "yaml",
    writable: false,
    snippet: (options) =>
      [
        "mcpServers:",
        `  - name: ${MCP_SERVER_KEY}`,
        `    command: ${options.launch.command}`,
        "    args:",
        ...options.launch.args.map((arg) => `      - ${arg}`),
        "    env:",
        `      GITHUB_TOKEN: "${options.tokenPlaceholder}"`,
      ].join("\n"),
    notes: [
      "Merge into ~/.continue/config.yaml (or the config selected in Continue).",
      "Token placeholders must be replaced locally and must never be committed.",
    ],
  },
  {
    id: "codex",
    name: "Codex CLI",
    configKind: "toml",
    writable: false,
    snippet: (options) =>
      [
        `[mcp_servers.${MCP_SERVER_KEY}]`,
        `command = ${JSON.stringify(options.launch.command)}`,
        `args = ${JSON.stringify(options.launch.args)}`,
        `env = { GITHUB_TOKEN = "${TOKEN_PLACEHOLDER}" }`,
      ].join("\n"),
    notes: [
      "Merge into ~/.codex/config.toml. Replace the token placeholder locally.",
      "Restart the Codex session after editing the file.",
    ],
  },
  {
    id: "generic",
    name: "Generic stdio MCP client",
    configKind: "json",
    writable: false,
    snippet: jsonServerConfig,
    notes: [
      "Any client that supports stdio MCP servers can launch the command directly with GITHUB_TOKEN in its environment.",
    ],
  },
];

export function getClientSetup(id: string): ClientSetup | undefined {
  return CLIENT_SETUPS.find((client) => client.id === id);
}

export function describeClients(): string {
  return CLIENT_SETUPS.map(
    (client) =>
      `  ${client.id.padEnd(16)} ${client.name}${client.writable ? " (--write supported)" : ""}`,
  ).join("\n");
}
