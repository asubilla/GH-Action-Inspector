/**
 * Memory-bounded response readers.
 *
 * Job logs can be tens of megabytes. They are never buffered in full: at most
 * `maxBytes` characters are retained, split between the head and the tail so
 * both early setup failures and final exit errors remain inspectable. The whole
 * stream may still be read over the network, but memory stays bounded and the
 * request is covered by the configured timeout.
 */

export interface CappedText {
  text: string;
  downloadedBytes: number;
  truncated: boolean;
}

export const TRUNCATION_MARKER = "\n[... log too large: middle section omitted by server ...]\n";

export async function readResponseTextCapped(
  response: Response,
  maxBytes: number,
): Promise<CappedText> {
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    const truncated = text.length > maxBytes;
    return {
      text: truncated ? text.slice(0, maxBytes) : text,
      downloadedBytes: Buffer.byteLength(text, "utf8"),
      truncated,
    };
  }

  const decoder = new TextDecoder();
  const headCap = Math.floor(maxBytes * 0.35);
  const tailCap = Math.max(1, maxBytes - headCap);
  let head = "";
  let tail = "";
  let downloadedBytes = 0;
  let truncated = false;

  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      downloadedBytes += value.byteLength;
      let chunk = decoder.decode(value, { stream: true });

      if (head.length < headCap) {
        const take = Math.min(chunk.length, headCap - head.length);
        head += chunk.slice(0, take);
        chunk = chunk.slice(take);
      }
      if (chunk === "") continue;

      tail += chunk;
      if (tail.length > tailCap) {
        tail = tail.slice(-tailCap);
        truncated = true;
      }
    }
    const finalChunk = decoder.decode();
    if (finalChunk !== "") {
      tail += finalChunk;
      if (tail.length > tailCap) {
        tail = tail.slice(-tailCap);
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text: truncated ? `${head}${TRUNCATION_MARKER}${tail}` : `${head}${tail}`,
    downloadedBytes,
    truncated,
  };
}

/** Release a response body we are not going to consume, so the socket can be reused. */
export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation failures are not actionable and must not mask the real error.
  }
}
