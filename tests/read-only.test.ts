import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const GITHUB_DIR = path.join(PROJECT_ROOT, "src", "github");
const SRC_DIR = path.join(PROJECT_ROOT, "src");

function listTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(directory, entry));
}

describe("read-only guarantee", () => {
  it("contains no HTTP method other than GET in the GitHub layer", () => {
    for (const file of listTypeScriptFiles(GITHUB_DIR)) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\bmethod\s*:\s*["'`](?:POST|PUT|PATCH|DELETE|HEAD)/);
      expect(source, file).not.toMatch(/\b(?:POST|PUT|PATCH|DELETE)\b\s*[/`"']/);
    }
  });

  it("does not reference write-capable GitHub endpoints", () => {
    const forbidden = [
      /\/dispatches/,
      /\/rerun/,
      /\/cancel/,
      /\/approve/,
      /\/pending_deployments/,
      /\/reviews/,
      /\/issues/,
      /\/pulls/,
      /\/merges/,
      /\/git\/refs/,
      /\/commits\b/,
      /\/releases/,
      /\/actions\/secrets/,
      /\/actions\/variables/,
      /\/branches\/[^/]+\/protection/,
    ];
    for (const file of listTypeScriptFiles(GITHUB_DIR)) {
      const source = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        expect(source, `${file} references ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("exposes only read-oriented methods on the GitHubReader interface", () => {
    const source = readFileSync(path.join(GITHUB_DIR, "types.ts"), "utf8");
    const interfaceStart = source.indexOf("export interface GitHubReader");
    const interfaceBody = source.slice(interfaceStart, source.indexOf("\n}", interfaceStart));
    const methods = [...interfaceBody.matchAll(/^\s{2}(\w+)\(/gm)].map((match) => match[1]);
    expect(methods.length).toBeGreaterThanOrEqual(10);
    for (const method of methods) {
      expect(method, `method ${method} looks write-capable`).not.toMatch(
        /^(?:create|update|delete|remove|trigger|cancel|rerun|dispatch|approve|merge|push|post|put|patch|set|add|close|reopen|edit)/i,
      );
    }
  });

  it("has no stdout logging that would corrupt the MCP stdio channel", () => {
    const allowed = new Set([
      path.join(SRC_DIR, "cli.ts"),
      path.join(SRC_DIR, "setup", "command.ts"),
    ]);
    for (const file of listTypeScriptFiles(SRC_DIR)) {
      if (allowed.has(file)) continue;
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/console\.log\(|process\.stdout\.write\(/);
    }
  });

  it("does not hardcode credential-shaped values in source or fixtures", () => {
    const files = [
      ...listTypeScriptFiles(path.join(PROJECT_ROOT, "src")),
      ...listTypeScriptFiles(path.join(PROJECT_ROOT, "tests")),
      ...listTypeScriptFiles(path.join(PROJECT_ROOT, "demo")),
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\bghp_[A-Za-z0-9]{30,}\b/);
      expect(source, file).not.toMatch(/\bgithub_pat_[A-Za-z0-9_]{30,}\b/);
      expect(source, file).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    }
  });
});
