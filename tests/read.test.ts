import { describe, expect, it } from "vitest";
import { readResponseTextCapped, TRUNCATION_MARKER } from "../src/github/read.js";

function streamingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/plain" } });
}

describe("bounded response reader", () => {
  it("returns small bodies unchanged", async () => {
    const result = await readResponseTextCapped(streamingResponse(["hello ", "world"]), 1_000);
    expect(result.text).toBe("hello world");
    expect(result.truncated).toBe(false);
    expect(result.downloadedBytes).toBe(11);
  });

  it("keeps head and tail when a body exceeds the cap", async () => {
    const head = "HEAD-".repeat(40);
    const middle = "X".repeat(5_000);
    const tail = "-TAIL".repeat(40);
    const result = await readResponseTextCapped(streamingResponse([head, middle, tail]), 400);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain("HEAD-");
    expect(result.text).toContain("-TAIL");
    expect(result.text).toContain(TRUNCATION_MARKER);
    expect(result.text.length).toBeLessThanOrEqual(400 + TRUNCATION_MARKER.length);
    expect(result.downloadedBytes).toBeGreaterThan(5_000);
  });

  it("marks a body truncated when the tail cap is exceeded", async () => {
    const result = await readResponseTextCapped(streamingResponse(["a".repeat(2_000)]), 500);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain(TRUNCATION_MARKER);
  });

  it("handles empty bodies", async () => {
    const result = await readResponseTextCapped(streamingResponse([]), 500);
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
    expect(result.downloadedBytes).toBe(0);
  });
});
