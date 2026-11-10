import { describe, expect, it } from "vitest";
import {
  buildConfig,
  compileExtraPatterns,
  DEFAULT_LOG_EXCERPT_CHARS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  HARD_MAX_LOG_EXCERPT_CHARS,
  loadConfig,
  normalizeBaseUrl,
} from "../src/config.js";
import { TriageError } from "../src/errors.js";

describe("configuration", () => {
  it("uses safe defaults without a token", () => {
    const config = buildConfig();
    expect(config.githubToken).toBeUndefined();
    expect(config.apiBaseUrl).toBe("https://api.github.com");
    expect(config.logExcerptChars).toBe(DEFAULT_LOG_EXCERPT_CHARS);
    expect(config.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(config.debug).toBe(false);
    expect(config.extraRedactionPatterns).toEqual([]);
  });

  it("reads documented environment variables and trims the token", () => {
    const config = loadConfig({
      GITHUB_TOKEN: "  fake-token  ",
      GITHUB_API_BASE_URL: "https://ghe.example.com/api/v3/",
      GH_ACTION_INSPECTOR_LOG_CHARS: "9000",
      GH_ACTION_INSPECTOR_TIMEOUT_MS: "20000",
      GH_ACTION_INSPECTOR_DEBUG: "true",
      GH_ACTION_INSPECTOR_EXTRA_REDACTION_PATTERNS: "acme-[0-9]+,internalid=[a-z]+",
    });
    expect(config.githubToken).toBe("fake-token");
    expect(config.apiBaseUrl).toBe("https://ghe.example.com/api/v3");
    expect(config.logExcerptChars).toBe(9000);
    expect(config.requestTimeoutMs).toBe(20000);
    expect(config.debug).toBe(true);
    expect(config.extraRedactionPatterns).toHaveLength(2);
  });

  it("clamps log excerpt size and timeout to safe ranges", () => {
    const tiny = buildConfig({ logExcerptChars: 1, requestTimeoutMs: 50 });
    expect(tiny.logExcerptChars).toBe(500);
    expect(tiny.requestTimeoutMs).toBe(1000);

    const huge = buildConfig({ logExcerptChars: 999_999, requestTimeoutMs: 999_999 });
    expect(huge.logExcerptChars).toBe(HARD_MAX_LOG_EXCERPT_CHARS);
    expect(huge.requestTimeoutMs).toBe(60_000);

    const garbage = buildConfig({ logExcerptChars: "not-a-number", requestTimeoutMs: "abc" });
    expect(garbage.logExcerptChars).toBe(DEFAULT_LOG_EXCERPT_CHARS);
    expect(garbage.requestTimeoutMs).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it("rejects malformed tokens without echoing them", () => {
    try {
      buildConfig({ githubToken: "ghp_secret\nvalue" });
      expect.unreachable("expected a configuration error");
    } catch (error) {
      expect(error).toBeInstanceOf(TriageError);
      const triage = error as TriageError;
      expect(triage.code).toBe("CONFIG_INVALID");
      expect(triage.message).not.toContain("ghp_secret");
    }
  });

  it("requires HTTPS for non-loopback API base URLs", () => {
    expect(() => normalizeBaseUrl("http://github.example.com/api")).toThrow(TriageError);
    expect(() => normalizeBaseUrl("ftp://api.github.com")).toThrow(TriageError);
    expect(normalizeBaseUrl("http://localhost:8080/api/v3")).toBe("http://localhost:8080/api/v3");
    expect(normalizeBaseUrl("http://127.0.0.1:8080")).toBe("http://127.0.0.1:8080");
  });

  it("rejects credentials, query strings, and fragments in the API base URL", () => {
    expect(() => normalizeBaseUrl("https://user:pass@api.github.com")).toThrow(TriageError);
    expect(() => normalizeBaseUrl("https://api.github.com?x=1")).toThrow(TriageError);
    expect(() => normalizeBaseUrl("https://api.github.com#fragment")).toThrow(TriageError);
    expect(() => normalizeBaseUrl("not a url")).toThrow(TriageError);
  });

  it("treats extra redaction patterns as additive and validates them", () => {
    expect(compileExtraPatterns(undefined)).toEqual([]);
    expect(compileExtraPatterns(" , \n ")).toEqual([]);
    const patterns = compileExtraPatterns(["acme-[0-9]+"]);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.test("acme-123")).toBe(true);

    expect(() => compileExtraPatterns(["("])).toThrow(TriageError);
    expect(() => compileExtraPatterns(["x".repeat(201)])).toThrow(TriageError);
  });

  it("parses only explicit truthy debug values", () => {
    expect(buildConfig({ debug: "1" }).debug).toBe(true);
    expect(buildConfig({ debug: "YES" }).debug).toBe(true);
    expect(buildConfig({ debug: "on" }).debug).toBe(true);
    expect(buildConfig({ debug: "false" }).debug).toBe(false);
    expect(buildConfig({ debug: "sure" }).debug).toBe(false);
  });
});
