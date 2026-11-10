#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, type AppConfig } from "./config.js";
import { HINTS, toSafeError } from "./errors.js";
import { createLazyGitHubReader } from "./github/client.js";
import { createLogger } from "./logger.js";
import { createServer } from "./server.js";
import { runSetupCommand } from "./setup/command.js";
import { detectClients } from "./setup/detect.js";
import { detectionJson } from "./setup/report.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const HELP = `${SERVER_NAME} ${SERVER_VERSION}

Read-only MCP server for inspecting failed GitHub Actions runs.

Usage:
  gh-action-inspector                     Start the MCP stdio server (default)
  gh-action-inspector serve               Start the MCP stdio server
  gh-action-inspector setup [options]     Interactive wizard, detection report, or targeted config
  gh-action-inspector doctor              Check configuration and GitHub access
  gh-action-inspector --help              Show this help
  gh-action-inspector --version           Show the version

Environment:
  GITHUB_TOKEN                                    Required for GitHub access. Never pass it as an argument.
  GITHUB_API_BASE_URL                             Optional HTTPS API base (GitHub Enterprise), default https://api.github.com
  GH_ACTION_INSPECTOR_LOG_CHARS                   Optional default log excerpt size (500-20000, default 6000)
  GH_ACTION_INSPECTOR_TIMEOUT_MS                  Optional request timeout (1000-60000, default 15000)
  GH_ACTION_INSPECTOR_DEBUG                       Set to true for non-sensitive stderr diagnostics
  GH_ACTION_INSPECTOR_EXTRA_REDACTION_PATTERNS    Optional comma/newline-separated additive regexes

Examples:
  gh-action-inspector setup                       # detect clients and choose what to configure
  gh-action-inspector setup --detect              # show detected clients and evidence only
  gh-action-inspector setup --detect --json       # machine-readable detection report
  gh-action-inspector setup --interactive         # force the wizard
  gh-action-inspector setup --client cursor --write
  gh-action-inspector setup --client claude-code
  gh-action-inspector doctor --repo octocat/hello-world

The server only reads GitHub Actions data. It cannot trigger, cancel, rerun, approve, or
dispatch workflows, create issues or pull requests, push code, or change repository settings.
`;

export async function runStdioServer(config: AppConfig = loadConfig()): Promise<void> {
  const logger = createLogger(config.debug);
  if (config.githubToken === undefined) {
    logger.warn("github_token_missing", {
      detail: "Tools will return setup guidance until GITHUB_TOKEN is configured.",
    });
  }

  const server = createServer({ config, logger });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("mcp_server_started", {
    transport: "stdio",
    serverVersion: SERVER_VERSION,
    apiBaseUrl: config.apiBaseUrl,
    logExcerptChars: config.logExcerptChars,
    debug: config.debug,
  });

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    logger.info("mcp_server_stopping", { signal });
    void server
      .close()
      .catch(() => undefined)
      .finally(() => {
        process.exit(0);
      });
  };
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.once("SIGHUP", () => {
    shutdown("SIGHUP");
  });
}

async function runDoctor(args: readonly string[]): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config.debug);
  const report: Record<string, unknown> = {
    server: { name: SERVER_NAME, version: SERVER_VERSION },
    runtime: { node: process.version, platform: process.platform },
    config: {
      apiBaseUrl: config.apiBaseUrl,
      logExcerptChars: config.logExcerptChars,
      requestTimeoutMs: config.requestTimeoutMs,
      debug: config.debug,
      extraRedactionPatterns: config.extraRedactionPatterns.length,
    },
    clients: detectionJson(detectClients()),
    token: {
      configured: config.githubToken !== undefined,
      source: "GITHUB_TOKEN",
    },
  };

  if (config.githubToken === undefined) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n\n${HINTS.authMissing}\n`);
    return 1;
  }

  const client = createLazyGitHubReader(config, logger);
  try {
    const user = await client.getAuthenticatedUser();
    const rateLimit = await client.getRateLimit();
    const doctor: Record<string, unknown> = {
      ...report,
      authenticatedAs: user.login,
      rateLimit,
    };

    const repoArg = readFlag(args, "--repo");
    if (repoArg !== undefined) {
      const [owner, repo, extra] = repoArg.split("/");
      if (owner === undefined || repo === undefined || extra !== undefined) {
        process.stderr.write("--repo must use the form owner/repository.\n");
        return 1;
      }
      const repository = await client.getRepository(owner, repo);
      const runs = await client.listWorkflowRuns({ owner, repo, limit: 1, page: 1 });
      doctor.repository = {
        fullName: repository.repository.fullName,
        private: repository.repository.private,
        permissions: repository.repository.permissions,
        visibleRuns: runs.totalCount,
      };
    }

    process.stdout.write(`${JSON.stringify(doctor, null, 2)}\n`);
    return 0;
  } catch (error) {
    const safe = toSafeError(error);
    process.stdout.write(
      `${JSON.stringify({ ...report, error: safe }, null, 2)}\n\n${safe.hint}\n`,
    );
    return 1;
  }
}

function readFlag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("-") ? undefined : value;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return 0;
  }
  if (command === "setup") {
    return runSetupCommand(rest);
  }
  if (command === "doctor") {
    return runDoctor(rest);
  }
  if (command === undefined || command === "serve" || command === "stdio") {
    await runStdioServer();
    return 0;
  }

  process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
  return 1;
}

main(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((error: unknown) => {
    const safe = toSafeError(error);
    process.stderr.write(`error [${safe.code}]: ${safe.message}\n${safe.hint}\n`);
    process.exitCode = 1;
  });
