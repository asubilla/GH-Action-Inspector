import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type AppConfig } from "./config.js";
import { createLazyGitHubReader } from "./github/client.js";
import type { GitHubReader } from "./github/types.js";
import { createLogger, type Logger } from "./logger.js";
import { registerTools } from "./tools/index.js";
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_TITLE, SERVER_VERSION } from "./version.js";

export interface CreateServerOptions {
  config?: AppConfig;
  /** Inject a reader for tests and the synthetic demo. Production uses the GitHub client. */
  client?: GitHubReader;
  logger?: Logger;
}

/**
 * Build the MCP server and register every read-only tool.
 *
 * The server can start without GITHUB_TOKEN: tool calls then return actionable
 * authentication guidance instead of the process exiting. This makes setup
 * failures visible in the assistant rather than in a client log file.
 */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config.debug);
  const client = options.client ?? createLazyGitHubReader(config, logger);

  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: SERVER_TITLE,
      version: SERVER_VERSION,
      description:
        "GH Action Inspector: read-only inspection of failed GitHub Actions runs, jobs, redacted log excerpts, deterministic failure analysis, and comparisons.",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  registerTools(server, { client, config, logger });
  return server;
}

export { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_TITLE, SERVER_VERSION };
export type { GitHubReader };
