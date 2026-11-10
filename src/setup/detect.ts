import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CLIENT_SETUPS, type ClientId, type ClientSetup } from "./clients.js";

export interface DetectionContext {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface ClientDetection {
  client: ClientSetup;
  installed: boolean;
  evidence: string[];
  configPath: string | null;
  configExists: boolean;
}

interface ExtensionProbe {
  label: string;
  prefixes: readonly string[];
}

interface ClientProbe {
  commands?: readonly string[];
  paths?: (context: DetectionContext) => readonly string[];
  extensions?: readonly ExtensionProbe[];
}

interface PlatformPaths {
  darwin?: readonly string[];
  win32?: readonly string[];
  linux?: readonly string[];
}

const EXTENSION_ROOTS = [
  path.join(".vscode", "extensions"),
  path.join(".vscode-insiders", "extensions"),
  path.join(".cursor", "extensions"),
  path.join(".windsurf", "extensions"),
];

const CLINE_EXTENSIONS: readonly ExtensionProbe[] = [
  { label: "Cline extension", prefixes: ["saoudrizwan.claude-dev-"] },
];

const CONTINUE_EXTENSIONS: readonly ExtensionProbe[] = [
  { label: "Continue extension", prefixes: ["continue.continue-"] },
];

function currentPlatformPaths(context: DetectionContext, values: PlatformPaths): string[] {
  if (context.platform === "darwin") return [...(values.darwin ?? [])];
  if (context.platform === "win32") return [...(values.win32 ?? [])];
  if (context.platform === "linux") return [...(values.linux ?? [])];
  return [];
}

function localAppData(context: DetectionContext): string {
  return context.env.LOCALAPPDATA ?? path.join(context.home, "AppData", "Local");
}

function roamingAppData(context: DetectionContext): string {
  return context.env.APPDATA ?? path.join(context.home, "AppData", "Roaming");
}

const PROBES: Record<Exclude<ClientId, "generic">, ClientProbe> = {
  "claude-desktop": {
    paths: (context) => [
      ...currentPlatformPaths(context, {
        darwin: [
          "/Applications/Claude.app",
          path.join(context.home, "Library", "Application Support", "Claude"),
        ],
        win32: [
          path.join(localAppData(context), "AnthropicClaude"),
          path.join(localAppData(context), "Programs", "Claude"),
        ],
        linux: ["/opt/Claude", "/usr/share/claude", path.join(context.home, ".config", "Claude")],
      }),
    ],
  },
  cursor: {
    commands: ["cursor"],
    paths: (context) => [
      ...currentPlatformPaths(context, {
        darwin: ["/Applications/Cursor.app"],
        win32: [
          path.join(localAppData(context), "Programs", "cursor"),
          path.join(localAppData(context), "Cursor"),
        ],
        linux: ["/usr/share/cursor", "/opt/Cursor"],
      }),
      path.join(context.home, ".cursor"),
    ],
  },
  vscode: {
    commands: ["code"],
    paths: (context) => [
      ...currentPlatformPaths(context, {
        darwin: ["/Applications/Visual Studio Code.app"],
        win32: [path.join(localAppData(context), "Programs", "Microsoft VS Code")],
        linux: ["/usr/share/code"],
      }),
      path.join(context.home, ".vscode"),
    ],
  },
  windsurf: {
    commands: ["windsurf"],
    paths: (context) => [
      ...currentPlatformPaths(context, {
        darwin: ["/Applications/Windsurf.app"],
        win32: [path.join(localAppData(context), "Programs", "Windsurf")],
        linux: ["/usr/share/windsurf"],
      }),
      path.join(context.home, ".codeium", "windsurf"),
    ],
  },
  zed: {
    commands: ["zed"],
    paths: (context) => [
      ...currentPlatformPaths(context, {
        darwin: ["/Applications/Zed.app"],
        win32: [
          path.join(localAppData(context), "Programs", "Zed"),
          path.join(roamingAppData(context), "Zed"),
        ],
        linux: ["/usr/bin/zed", "/usr/local/bin/zed"],
      }),
      path.join(context.home, ".config", "zed"),
    ],
  },
  "claude-code": {
    commands: ["claude"],
    paths: (context) => [path.join(context.home, ".claude")],
  },
  cline: {
    extensions: CLINE_EXTENSIONS,
  },
  jetbrains: {
    paths: (context) => [
      ...currentPlatformPaths(context, {
        darwin: [
          "/Applications/IntelliJ IDEA.app",
          "/Applications/JetBrains Toolbox.app",
          path.join(context.home, "Library", "Application Support", "JetBrains"),
        ],
        win32: [
          path.join(roamingAppData(context), "JetBrains"),
          path.join(localAppData(context), "JetBrains", "Toolbox"),
          path.join(localAppData(context), "Programs", "IntelliJ IDEA"),
        ],
        linux: [
          path.join(context.home, ".config", "JetBrains"),
          path.join(context.home, ".local", "share", "JetBrains"),
          "/opt/idea",
          "/usr/share/idea",
        ],
      }),
    ],
  },
  continue: {
    commands: ["continue"],
    paths: (context) => [path.join(context.home, ".continue")],
    extensions: CONTINUE_EXTENSIONS,
  },
  codex: {
    commands: ["codex"],
    paths: (context) => [path.join(context.home, ".codex")],
  },
};

function pathDirectories(context: DetectionContext): string[] {
  const entry = Object.entries(context.env).find(([key]) => key.toLowerCase() === "path");
  const raw = entry?.[1];
  if (raw === undefined) return [];
  return raw
    .split(context.platform === "win32" ? ";" : ":")
    .map((directory) => directory.replace(/^"(.*)"$/, "$1").trim())
    .filter((directory) => directory.length > 0);
}

function findOnPath(command: string, context: DetectionContext): string | undefined {
  const extensions = context.platform === "win32" ? [".exe", ".cmd", ".bat", ".com", ""] : [""];
  for (const directory of pathDirectories(context)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function findExtensions(context: DetectionContext, probe: ExtensionProbe): string[] {
  const found: string[] = [];
  for (const relativeRoot of EXTENSION_ROOTS) {
    const root = path.join(context.home, relativeRoot);
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (!probe.prefixes.some((prefix) => entry.name.startsWith(prefix))) continue;
        found.push(path.join(root, entry.name));
      }
    } catch {
      // Missing or unreadable extension directories are simply not evidence.
    }
  }
  return found;
}

function evidenceFor(client: ClientSetup, context: DetectionContext): string[] {
  if (client.id === "generic") return [];
  const probe = PROBES[client.id];
  const evidence: string[] = [];

  for (const command of probe.commands ?? []) {
    const found = findOnPath(command, context);
    if (found !== undefined) evidence.push(`command "${command}" on PATH: ${found}`);
  }

  for (const candidate of probe.paths?.(context) ?? []) {
    if (existsSync(candidate)) evidence.push(candidate);
  }

  for (const extension of probe.extensions ?? []) {
    for (const found of findExtensions(context, extension)) {
      evidence.push(`${extension.label}: ${found}`);
    }
  }

  return evidence;
}

function resolveConfigPath(client: ClientSetup, context: DetectionContext): string | null {
  if (client.resolvePath === undefined) return null;
  try {
    return client.resolvePath({ home: context.home, cwd: context.cwd });
  } catch {
    return null;
  }
}

export function defaultDetectionContext(): DetectionContext {
  return {
    home: homedir(),
    cwd: process.cwd(),
    platform: process.platform,
    env: process.env,
  };
}

/**
 * Detect clients from filesystem markers and PATH entries without reading any
 * configuration contents. Detection is advisory: every client remains
 * selectable when its installation cannot be found automatically.
 */
export function detectClients(
  context: DetectionContext = defaultDetectionContext(),
): ClientDetection[] {
  return CLIENT_SETUPS.map((client) => {
    const configPath = resolveConfigPath(client, context);
    const configExists = configPath !== null && existsSync(configPath);
    const evidence = evidenceFor(client, context);
    if (configExists) evidence.push(`existing config: ${configPath}`);
    return {
      client,
      installed: evidence.length > 0,
      evidence,
      configPath,
      configExists,
    };
  });
}
