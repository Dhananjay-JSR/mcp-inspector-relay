import { describe, expect, it } from "vitest";
import { createEndpointRewriter, rewriteEventBlock } from "../src/sse";

const upstream = new URL("https://mcp.example.com/sse");
const relayOrigin = "https://relay.example";

const endpointUrl =
  "https://relay.example/message?url=https%3A%2F%2Fmcp.example.com%2Fmessages%3FsessionId%3Dabc";

describe("rewriteEventBlock", () => {
  it("rewrites the endpoint event through the relay", () => {
    const block = "event: endpoint\ndata: /messages?sessionId=abc\n\n";
    expect(rewriteEventBlock(block, upstream, relayOrigin)).toContain(`data: ${endpointUrl}`);
  });

  it("leaves message events untouched", () => {
    const block = "event: message\ndata: {\"jsonrpc\":\"2.0\"}\n\n";
    expect(rewriteEventBlock(block, upstream, relayOrigin)).toBe(block);
  });

  it("leaves malformed endpoint data untouched", () => {
    const block = "event: endpoint\ndata: http://[\n\n";
    expect(rewriteEventBlock(block, upstream, relayOrigin)).toContain("data: http://[");
  });
});

describe("createEndpointRewriter", () => {
  it("rewrites an endpoint split across chunks", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: endpo"));
        controller.enqueue(encoder.encode("int\ndata: /messages?sessionId=abc\n\n"));
        controller.enqueue(encoder.encode("event: message\ndata: hi\n\n"));
        controller.close();
      },
    });

    const text = await new Response(
      source.pipeThrough(createEndpointRewriter(upstream, relayOrigin)),
    ).text();

    expect(text).toContain(`data: ${endpointUrl}`);
    expect(text).toContain("event: message\ndata: hi");
  });
});
