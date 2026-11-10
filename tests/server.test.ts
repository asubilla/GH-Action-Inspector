import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { createServer, SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from "../src/server.js";
import { TOOL_NAMES } from "../src/tools/index.js";
import { FakeGitHubReader } from "./helpers/fake-github.js";

const silentSink = { write: (): boolean => true };
let client: Client | null = null;

afterEach(async () => {
  if (client !== null) {
    await client.close();
    client = null;
  }
});

describe("MCP server startup", () => {
  it("starts over stdio-compatible transport and exposes all tools with read-only annotations", async () => {
    const server = createServer({
      config: buildConfig({ githubToken: "synthetic-token" }),
      client: new FakeGitHubReader(),
      logger: createLogger(false, silentSink),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "startup-test", version: "1.0.0" });
    await client.connect(clientTransport);

    const version = client.getServerVersion();
    expect(version?.name).toBe(SERVER_NAME);
    expect(version?.version).toBe(SERVER_VERSION);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.description?.startsWith("READ-ONLY.")).toBe(true);
    }

    await client.close();
    client = null;
    await server.close();
  });

  it("starts without a token so tools can explain the missing configuration", async () => {
    const server = createServer({
      config: buildConfig({}),
      logger: createLogger(false, silentSink),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "startup-no-token-test", version: "1.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(TOOL_NAMES.length);

    await client.close();
    client = null;
    await server.close();
  });

  it("advertises the read-only guarantee in server instructions", () => {
    expect(SERVER_INSTRUCTIONS).toContain("Read-only");
    expect(SERVER_INSTRUCTIONS).toContain("cannot trigger, cancel, rerun");
    expect(SERVER_INSTRUCTIONS).toContain("untrusted data");
  });
});
