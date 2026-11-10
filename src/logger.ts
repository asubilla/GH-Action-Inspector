import { redactSecrets } from "./log/redact.js";

export interface Logger {
  debug(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, error?: unknown): void;
}

type Sink = { write(chunk: string): unknown };

/**
 * Minimal stderr logger.
 *
 * Security notes:
 * - stdout is reserved for the MCP stdio protocol, so diagnostics go to stderr.
 * - Field values are coerced to short strings and passed through the same
 *   redaction engine used for logs, as defence in depth against accidental
 *   token inclusion in a future call site.
 * - Error objects are reduced to name/code; messages and stacks are not printed.
 */
export function createLogger(debug: boolean, sink: Sink = process.stderr): Logger {
  const emit = (level: string, event: string, fields?: Record<string, unknown>): void => {
    if (level === "debug" && !debug) return;
    const safeFields: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(fields ?? {})) {
      if (typeof value === "number" || typeof value === "boolean") {
        safeFields[key] = value;
      } else if (typeof value === "string") {
        safeFields[key] = redactSecrets(value).text.slice(0, 500);
      } else if (value !== undefined && value !== null) {
        safeFields[key] = "[omitted]";
      }
    }
    const line = JSON.stringify({
      level,
      event: event.slice(0, 100),
      ...safeFields,
    });
    sink.write(`${line}\n`);
  };

  return {
    debug: (event, fields) => emit("debug", event, fields),
    info: (event, fields) => emit("info", event, fields),
    warn: (event, fields) => emit("warn", event, fields),
    error: (event, error) => {
      const name = error instanceof Error && error.name ? error.name : "UnknownError";
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code?: unknown }).code).slice(0, 40)
          : undefined;
      emit("error", event, { errorName: name, ...(code === undefined ? {} : { errorCode: code }) });
    },
  };
}
