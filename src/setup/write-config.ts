import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createJsonEntry, MCP_SERVER_KEY, type ClientSetup, type SetupOptions } from "./clients.js";

export interface WriteResult {
  path: string;
  created: boolean;
  backupPath: string | null;
}

/**
 * Merge one server entry into a client's JSON config without touching other
 * servers. Refuses to overwrite files that are not valid JSON (for example
 * JSONC with comments) instead of silently destroying user settings.
 *
 * Never writes a real token: the caller supplies a placeholder and the user
 * replaces it locally. Files are created with 0600 permissions.
 */
export async function writeClientConfig(
  client: ClientSetup,
  setup: SetupOptions,
  context: { cwd?: string; home?: string } = {},
): Promise<WriteResult> {
  if (!client.writable || client.configKind !== "json" || client.mergeKey === undefined) {
    throw new Error(`Client ${client.id} does not support --write.`);
  }
  if (client.resolvePath === undefined) {
    throw new Error(`Client ${client.id} has no known configuration path.`);
  }

  const cwd = context.cwd ?? process.cwd();
  const home = context.home ?? homedir();
  const configPath = client.resolvePath({ cwd, home });
  if (configPath === null) {
    throw new Error(`Client ${client.id} has no known configuration path.`);
  }

  const exists = existsSync(configPath);
  let document: Record<string, unknown> = {};

  if (exists) {
    const raw = await readFile(configPath, "utf8");
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("top-level value is not an object");
      }
      document = parsed as Record<string, unknown>;
    } catch {
      throw new Error(
        `Refusing to overwrite ${configPath}: it is not strict JSON (it may contain comments). Merge the printed snippet manually.`,
      );
    }
  }

  const currentBucket = document[client.mergeKey];
  if (
    currentBucket !== undefined &&
    (typeof currentBucket !== "object" || currentBucket === null || Array.isArray(currentBucket))
  ) {
    throw new Error(
      `Refusing to modify ${configPath}: "${client.mergeKey}" is not an object. Merge the printed snippet manually.`,
    );
  }

  const bucket = { ...(currentBucket as Record<string, unknown> | undefined) };
  bucket[MCP_SERVER_KEY] = createJsonEntry(client.id, setup);
  document[client.mergeKey] = bucket;

  const directory = path.dirname(configPath);
  await mkdir(directory, { recursive: true });

  let backupPath: string | null = null;
  if (exists) {
    backupPath = `${configPath}.bak-${Date.now()}`;
    await writeFile(backupPath, await readFile(configPath), { mode: 0o600 });
    await chmod(backupPath, 0o600);
  }

  await writeFile(configPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);

  return { path: configPath, created: !exists, backupPath };
}
