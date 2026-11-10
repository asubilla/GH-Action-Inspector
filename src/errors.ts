/**
 * Error model for the server.
 *
 * Every error that can reach an MCP client is mapped to a small, fixed shape that
 * contains no credentials, request headers, stack traces, or raw upstream bodies.
 * Repository and run identifiers are safe to include; tokens and URLs with
 * embedded credentials are never passed to these constructors.
 */

export const ERROR_CODES = [
  "AUTH_MISSING",
  "AUTH_INVALID",
  "FORBIDDEN",
  "NOT_FOUND",
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK",
  "UPSTREAM",
  "RESPONSE_TOO_LARGE",
  "LOG_UNAVAILABLE",
  "INVALID_INPUT",
  "CONFIG_INVALID",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface SafeError {
  code: ErrorCode;
  message: string;
  hint: string;
  status?: number;
  requestId?: string;
  retryAfterSeconds?: number;
}

export interface TriageErrorOptions {
  hint: string;
  status?: number | undefined;
  requestId?: string | undefined;
  retryAfterSeconds?: number | undefined;
  cause?: unknown;
}

export class TriageError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;
  readonly status: number | undefined;
  readonly requestId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: ErrorCode, message: string, options: TriageErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TriageError";
    this.code = code;
    this.hint = options.hint;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/**
 * Convert any thrown value into the only error shape returned by this server.
 * Unknown errors are deliberately flattened so internal details cannot leak.
 */
export function toSafeError(error: unknown): SafeError {
  if (error instanceof TriageError) {
    return {
      code: error.code,
      message: error.message,
      hint: error.hint,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    };
  }

  return {
    code: "INTERNAL",
    message: "An unexpected internal error occurred.",
    hint: "Retry the tool once. If the problem persists, run with GH_ACTION_INSPECTOR_DEBUG=true and inspect the server's stderr output for non-sensitive diagnostics.",
  };
}

export const HINTS = {
  authMissing:
    "Set GITHUB_TOKEN in the environment used to launch this MCP server. Use a fine-grained token limited to the target repository with Actions: read and Metadata: read (add Contents: read only for get_workflow_file_metadata). Restart the MCP client after changing the environment.",
  authInvalid:
    "The token was rejected by GitHub. Check that it has not expired or been revoked, then create a new read-only token and update GITHUB_TOKEN. Tokens are never accepted as tool arguments.",
  forbidden:
    "The token is valid but lacks permission for this operation. Fine-grained tokens need Actions: read for runs, jobs, and logs, and Metadata: read for repository details. Repository administrators may also restrict fine-grained token access.",
  notFound:
    "GitHub returned 404. Verify the owner, repository, run ID, and workflow path. For private repositories a 404 can also mean the token cannot see the repository at all.",
  rateLimited:
    "GitHub's API rate limit was reached. Wait until the limit resets (see retryAfterSeconds or the reset time), reduce limits/lookback, or use a token with a higher quota. This server never retries rate-limited requests.",
  timeout:
    "The GitHub request timed out. Check network connectivity or the GITHUB_API_BASE_URL for GitHub Enterprise, then retry. Reduce the requested log size or number of jobs to lower the work per call.",
  network:
    "Could not reach the GitHub API. Verify network access and, for GitHub Enterprise, GITHUB_API_BASE_URL. HTTPS is required except for localhost development.",
  upstream:
    "GitHub returned an unexpected response. Retry once; if it persists, check GitHub's status page and the requestId if one is present.",
  responseTooLarge:
    "The response exceeded the server's safety limit. Request fewer results, a smaller maxChars, or a narrower date range.",
  logUnavailable:
    "The job log is not available. Logs expire (typically after 90 days), are removed for deleted runs, or require Actions: read permission. Check the run page, or retry after confirming token access.",
  invalidInput: "Check the tool arguments against the tool's input schema and retry.",
  configInvalid:
    "Fix the server configuration. See .env.example and the README configuration section, then restart the MCP server.",
  internal:
    "Retry once. If the error continues, enable GH_ACTION_INSPECTOR_DEBUG=true and inspect stderr for diagnostics that exclude credentials and log bodies.",
} as const;
