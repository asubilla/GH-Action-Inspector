/**
 * Best-effort secret redaction for untrusted text (job logs and workflow files).
 *
 * This is deliberately conservative and additive-only. It removes high-signal
 * credential formats and secret-like assignments. It cannot guarantee that every
 * secret is removed: logs may contain arbitrary user data, and GitHub's own
 * masking is incomplete. Callers must still warn users to review output.
 */

export interface RedactionResult {
  text: string;
  redactionCount: number;
  categories: string[];
  /** Number of GitHub `***` masked placeholders seen in the input. */
  maskedPlaceholderCount: number;
}

type Replacer = string | ((substring: string, ...args: string[]) => string);

interface RedactionRule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly replacement: Replacer;
}

/**
 * Patterns are intentionally simple and bounded to avoid catastrophic
 * backtracking on hostile log input.
 */
const BUILT_IN_RULES: readonly RedactionRule[] = [
  {
    id: "private-key-block",
    pattern:
      /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,20000}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/gi,
    replacement: "[REDACTED:private-key-block]",
  },
  {
    // A truncated log or excerpt can contain a BEGIN marker without its END
    // marker. Redact conservatively from the header to the end of the text.
    id: "private-key-unterminated",
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----([\s\S]*)/gi,
    replacement: "[REDACTED:private-key-block]",
  },
  {
    id: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g,
    replacement: "[REDACTED:github-token]",
  },
  {
    id: "authorization-header",
    pattern: /\b(authorization\s*:\s*)(?:bearer\s+|token\s+|basic\s+)?[A-Za-z0-9._~+/=-]{6,}/gi,
    replacement: "$1[REDACTED:authorization]",
  },
  {
    id: "bearer-token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: "Bearer [REDACTED:bearer-token]",
  },
  {
    id: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA)[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED:aws-access-key]",
  },
  {
    id: "slack-token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,255}\b/g,
    replacement: "[REDACTED:slack-token]",
  },
  {
    id: "stripe-key",
    pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,255}\b/g,
    replacement: "[REDACTED:stripe-key]",
  },
  {
    id: "npm-token",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
    replacement: "[REDACTED:npm-token]",
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: "[REDACTED:google-api-key]",
  },
  {
    id: "gitlab-token",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,255}\b/g,
    replacement: "[REDACTED:gitlab-token]",
  },
  {
    id: "anthropic-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,255}\b/g,
    replacement: "[REDACTED:anthropic-key]",
  },
  {
    id: "openai-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,255}\b/g,
    replacement: "[REDACTED:openai-key]",
  },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g,
    replacement: "[REDACTED:jwt]",
  },
  {
    id: "url-userinfo",
    pattern: /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replacement: "$1[REDACTED:credentials]@",
  },
  {
    id: "sensitive-query-param",
    pattern:
      /([?&](?:token|access_token|auth|api_key|apikey|key|secret|password|sig|signature)=)[^&\s#]+/gi,
    replacement: "$1[REDACTED]",
  },
  {
    id: "json-secret-property",
    pattern:
      /("[A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret|credential|auth)[A-Za-z0-9_.-]*"\s*:\s*)("[^"\n]{1,300}"|[^\s,}]{1,300})/gi,
    replacement: '$1"[REDACTED:secret]"',
  },
  {
    id: "secret-assignment",
    pattern:
      /\b([A-Za-z0-9_.-]{0,40}(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CLIENT[_-]?SECRET|CREDENTIALS?|AUTH)[A-Za-z0-9_.-]{0,40})(\s*[=:]\s*)("[^"\n]{1,300}"|'[^'\n]{1,300}'|[^\s,;&]{4,300})/gi,
    replacement: "$1$2[REDACTED:secret]",
  },
];

const MASKED_PLACEHOLDER = /\*{3,}/g;

export interface RedactOptions {
  /** Additive patterns; built-in rules always run first and cannot be disabled. */
  extraPatterns?: readonly RegExp[] | undefined;
}

export function redactSecrets(input: string, options: RedactOptions = {}): RedactionResult {
  if (input === "") {
    return { text: "", redactionCount: 0, categories: [], maskedPlaceholderCount: 0 };
  }

  let text = input;
  let redactionCount = 0;
  const categories = new Set<string>();

  for (const rule of BUILT_IN_RULES) {
    rule.pattern.lastIndex = 0;
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      redactionCount += 1;
      categories.add(rule.id);
      if (typeof rule.replacement === "function") {
        return rule.replacement(...(args as [string, ...string[]]));
      }
      // Expand $1-style replacement groups from the match arguments.
      return rule.replacement.replace(/\$(\d+)/g, (_match, group: string) => {
        const index = Number.parseInt(group, 10);
        const value = args[index];
        return typeof value === "string" ? value : "";
      });
    });
  }

  for (const pattern of options.extraPatterns ?? []) {
    const global = new RegExp(
      pattern.source,
      pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
    );
    text = text.replace(global, () => {
      redactionCount += 1;
      categories.add("custom-pattern");
      return "[REDACTED:custom]";
    });
  }

  const maskedPlaceholderCount = (input.match(MASKED_PLACEHOLDER) ?? []).length;

  return {
    text,
    redactionCount,
    categories: [...categories].sort(),
    maskedPlaceholderCount,
  };
}

/** Convenience wrapper used by the stderr logger and by workflow-file sanitization. */
export function redactText(input: string, extraPatterns?: readonly RegExp[]): string {
  return redactSecrets(input, { extraPatterns }).text;
}

export const REDACTION_DISCLAIMER =
  "Redaction is best-effort and pattern-based. GitHub-masked values, unusual credential formats, and secrets embedded in arbitrary text may remain. Review output before sharing it.";
