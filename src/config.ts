import { HINTS, TriageError } from "./errors.js";

export const DEFAULT_API_BASE_URL = "https://api.github.com";

export const MIN_LOG_EXCERPT_CHARS = 500;
export const DEFAULT_LOG_EXCERPT_CHARS = 6_000;
/**
 * Conservative hard ceiling for any log text returned to a client. It cannot be
 * raised by environment configuration; this is intentional.
 */
export const HARD_MAX_LOG_EXCERPT_CHARS = 20_000;

export const MIN_REQUEST_TIMEOUT_MS = 1_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const MAX_REQUEST_TIMEOUT_MS = 60_000;

/** Maximum bytes downloaded for a single job log before head/tail truncation. */
export const MAX_LOG_DOWNLOAD_BYTES = 8 * 1024 * 1024;
/** Maximum bytes read from a JSON API response. */
export const MAX_JSON_BYTES = 4 * 1024 * 1024;
/** Maximum workflow-file characters ever decoded. */
export const MAX_WORKFLOW_FILE_CHARS = 20_000;
/** Maximum serialized tool response size, as a final safety net. */
export const MAX_TOOL_RESPONSE_CHARS = 100_000;

const MAX_TOKEN_LENGTH = 4_096;
const MAX_EXTRA_PATTERNS = 20;
const MAX_EXTRA_PATTERN_LENGTH = 200;

export interface AppConfig {
  /** Token is optional at startup so tools can return actionable guidance instead of crashing. */
  readonly githubToken: string | undefined;
  readonly apiBaseUrl: string;
  readonly logExcerptChars: number;
  readonly requestTimeoutMs: number;
  readonly debug: boolean;
  /**
   * Additional redaction patterns. They are strictly additive; built-in patterns
   * can never be removed or overridden through configuration.
   */
  readonly extraRedactionPatterns: readonly RegExp[];
}

export interface ConfigInput {
  githubToken?: string | undefined;
  apiBaseUrl?: string | undefined;
  logExcerptChars?: number | string | undefined;
  requestTimeoutMs?: number | string | undefined;
  debug?: boolean | string | undefined;
  extraRedactionPatterns?: string | readonly string[] | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return buildConfig({
    githubToken: env.GITHUB_TOKEN,
    apiBaseUrl: env.GITHUB_API_BASE_URL,
    logExcerptChars: env.GH_ACTION_INSPECTOR_LOG_CHARS,
    requestTimeoutMs: env.GH_ACTION_INSPECTOR_TIMEOUT_MS,
    debug: env.GH_ACTION_INSPECTOR_DEBUG,
    extraRedactionPatterns: env.GH_ACTION_INSPECTOR_EXTRA_REDACTION_PATTERNS,
  });
}

/**
 * Build a validated configuration object. Values are clamped to safe ranges;
 * malformed security-relevant values (token shape, base URL, extra patterns)
 * fail fast instead of being silently ignored.
 */
export function buildConfig(input: ConfigInput = {}): AppConfig {
  return {
    githubToken: normalizeToken(input.githubToken),
    apiBaseUrl: normalizeBaseUrl(input.apiBaseUrl),
    logExcerptChars: clampInt(
      input.logExcerptChars,
      MIN_LOG_EXCERPT_CHARS,
      HARD_MAX_LOG_EXCERPT_CHARS,
      DEFAULT_LOG_EXCERPT_CHARS,
    ),
    requestTimeoutMs: clampInt(
      input.requestTimeoutMs,
      MIN_REQUEST_TIMEOUT_MS,
      MAX_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
    ),
    debug: parseBoolean(input.debug),
    extraRedactionPatterns: compileExtraPatterns(input.extraRedactionPatterns),
  };
}

export function requireToken(config: AppConfig): string {
  if (config.githubToken === undefined) {
    throw new TriageError("AUTH_MISSING", "GITHUB_TOKEN is not configured.", {
      hint: HINTS.authMissing,
    });
  }
  return config.githubToken;
}

function normalizeToken(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const token = raw.trim();
  if (token === "") return undefined;
  if (token.length > MAX_TOKEN_LENGTH) {
    throw new TriageError("CONFIG_INVALID", "GITHUB_TOKEN is too long to be a GitHub token.", {
      hint: "Check that GITHUB_TOKEN contains only the token value and no additional text.",
    });
  }
  // Whitespace or control characters almost always indicate a malformed env var
  // (for example a pasted multi-line value). Never echo the value in the error.
  // eslint-disable-next-line no-control-regex -- detecting control characters is the point
  if (/[\s\u0000-\u001f\u007f]/.test(token)) {
    throw new TriageError(
      "CONFIG_INVALID",
      "GITHUB_TOKEN contains whitespace or control characters.",
      {
        hint: "Remove quotes, newlines, or extra text from GITHUB_TOKEN. Do not paste tokens into files that are committed.",
      },
    );
  }
  return token;
}

export function normalizeBaseUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim() || DEFAULT_API_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TriageError("CONFIG_INVALID", "GITHUB_API_BASE_URL is not a valid URL.", {
      hint: "Use an absolute HTTPS URL such as https://api.github.com or https://ghe.example.com/api/v3.",
    });
  }

  if (url.username !== "" || url.password !== "") {
    throw new TriageError("CONFIG_INVALID", "GITHUB_API_BASE_URL must not embed credentials.", {
      hint: "Remove the username or password from the URL. Supply the token only through GITHUB_TOKEN.",
    });
  }
  if (url.search !== "" || url.hash !== "") {
    throw new TriageError(
      "CONFIG_INVALID",
      "GITHUB_API_BASE_URL must not contain a query string or fragment.",
      { hint: "Use only the API base path, for example https://ghe.example.com/api/v3." },
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    throw new TriageError("CONFIG_INVALID", "GITHUB_API_BASE_URL must use HTTPS.", {
      hint: "HTTPS is required. Plain HTTP is accepted only for localhost during development.",
    });
  }

  return url.toString().replace(/\/+$/, "");
}

/** Loopback is allowed only for local development and tests, never for remote hosts. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function clampInt(
  raw: number | string | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export function parseBoolean(raw: boolean | string | undefined): boolean {
  if (typeof raw === "boolean") return raw;
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Extra patterns are additive only. They are compiled individually so one bad
 * expression produces a clear configuration error instead of disabling redaction.
 */
export function compileExtraPatterns(
  raw: string | readonly string[] | undefined,
): readonly RegExp[] {
  if (raw === undefined) return [];
  const items: readonly string[] =
    typeof raw === "string" ? raw.split(/[\n,]/).map((item) => item.trim()) : (raw ?? []);
  const patterns: RegExp[] = [];
  for (const [index, source] of items.entries()) {
    const trimmed = source.trim();
    if (trimmed === "") continue;
    if (patterns.length >= MAX_EXTRA_PATTERNS) {
      throw new TriageError(
        "CONFIG_INVALID",
        `GH_ACTION_INSPECTOR_EXTRA_REDACTION_PATTERNS exceeds ${MAX_EXTRA_PATTERNS} patterns.`,
        { hint: "Remove extra redaction patterns; built-in safety patterns remain active." },
      );
    }
    if (trimmed.length > MAX_EXTRA_PATTERN_LENGTH) {
      throw new TriageError(
        "CONFIG_INVALID",
        `GH_ACTION_INSPECTOR_EXTRA_REDACTION_PATTERNS entry #${index + 1} is too long.`,
        { hint: `Keep each extra pattern under ${MAX_EXTRA_PATTERN_LENGTH} characters.` },
      );
    }
    try {
      patterns.push(new RegExp(trimmed, "g"));
    } catch {
      throw new TriageError(
        "CONFIG_INVALID",
        `GH_ACTION_INSPECTOR_EXTRA_REDACTION_PATTERNS entry #${index + 1} is not a valid regular expression.`,
        { hint: "Fix or remove the invalid pattern. Built-in redaction remains mandatory." },
      );
    }
  }
  return patterns;
}
