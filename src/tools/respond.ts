import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MAX_TOOL_RESPONSE_CHARS } from "../config.js";
import { HINTS, TriageError, toSafeError } from "../errors.js";
import { redactText } from "../log/redact.js";
import type { ToolContext } from "./context.js";

/**
 * Serialize a tool payload as pretty JSON in a single text content block.
 * A hard character cap protects MCP clients from accidental huge responses.
 */
export function jsonText(payload: unknown): string {
  const text = JSON.stringify(payload, null, 2);
  if (text.length > MAX_TOOL_RESPONSE_CHARS) {
    throw new TriageError(
      "RESPONSE_TOO_LARGE",
      "The tool response exceeded the server's maximum size.",
      { hint: HINTS.responseTooLarge },
    );
  }
  return text;
}

/**
 * Execute a tool body and convert failures into a safe, structured error result.
 * Stack traces, headers, upstream bodies, and tokens are never returned.
 */
export async function runTool(
  ctx: ToolContext,
  toolName: string,
  body: () => Promise<unknown>,
): Promise<CallToolResult> {
  const startedAt = Date.now();
  try {
    const payload = await body();
    const text = jsonText(payload);
    ctx.logger.debug("tool_result", {
      tool: toolName,
      ok: true,
      ms: Date.now() - startedAt,
      chars: text.length,
    });
    return { content: [{ type: "text", text }] };
  } catch (error) {
    ctx.logger.error(`tool:${toolName}`, error);
    const safe = toSafeError(error);
    const text = JSON.stringify({ tool: toolName, error: safe, readOnly: true }, null, 2);
    return {
      isError: true,
      content: [{ type: "text", text: redactText(text) }],
    };
  }
}
