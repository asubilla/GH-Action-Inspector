import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildConfig, type AppConfig } from "../../src/config.js";
import type { GitHubReader } from "../../src/github/types.js";
import { createLogger } from "../../src/logger.js";
import { createServer } from "../../src/server.js";
import { FakeGitHubReader } from "./fake-github.js";

export const TEST_TOKEN = "test-token-value-not-real";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...buildConfig({ githubToken: TEST_TOKEN }),
    ...overrides,
  };
}

const silentSink = { write: (): boolean => true };

export interface Harness {
  client: Client;
  server: ReturnType<typeof createServer>;
  reader: FakeGitHubReader;
  config: AppConfig;
  close: () => Promise<void>;
}

export async function createHarness(
  options: {
    reader?: FakeGitHubReader;
    config?: AppConfig;
    client?: GitHubReader;
    loggerDebug?: boolean;
  } = {},
): Promise<Harness> {
  const reader = options.reader ?? new FakeGitHubReader();
  const config = options.config ?? testConfig();
  const server = createServer({
    config,
    client: options.client ?? reader,
    logger: createLogger(options.loggerDebug ?? false, silentSink),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    server,
    reader,
    config,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export async function callTool(
  harness: Harness,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const result = await harness.client.callTool({ name, arguments: args });
  return result as unknown as CallToolResult;
}

export function toolJson(result: CallToolResult): Record<string, unknown> {
  const content = result.content?.[0];
  if (content === undefined || content.type !== "text") {
    throw new Error("Expected a text content block");
  }
  const parsed: unknown = JSON.parse(content.text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object tool result");
  }
  return parsed as Record<string, unknown>;
}

export function toolText(result: CallToolResult): string {
  const content = result.content?.[0];
  if (content === undefined || content.type !== "text") {
    throw new Error("Expected a text content block");
  }
  return content.text;
}

export function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected object");
  }
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array");
  return value;
}
