const MAX_EVENT_SIZE = 64 * 1024;

function nextBoundary(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return -1;
  if (lf === -1) return crlf + 4;
  if (crlf === -1) return lf + 2;
  return lf < crlf ? lf + 2 : crlf + 4;
}

/**
 * Rewrites the legacy MCP SSE `endpoint` event so the browser posts messages
 * back through the relay instead of directly to the upstream server.
 */
export function rewriteEventBlock(block: string, upstream: URL, relayOrigin: string): string {
  const lines = block.split(/\r?\n/);
  let isEndpoint = false;
  let dataIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^event:\s*endpoint\s*$/.test(line)) {
      isEndpoint = true;
    }
    if (line.startsWith("data:")) {
      dataIndex = index;
    }
  }

  if (!isEndpoint || dataIndex === -1) {
    return lines.join("\n");
  }

  const raw = lines[dataIndex].slice(5).replace(/^ /, "");
  try {
    const endpoint = new URL(raw, upstream);
    lines[dataIndex] = `data: ${relayOrigin}/message?url=${encodeURIComponent(endpoint.href)}`;
  } catch {
    // Leave malformed endpoint data untouched; the client will surface it.
  }

  return lines.join("\n");
}

export function createEndpointRewriter(
  upstream: URL,
  relayOrigin: string,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      let boundary = nextBoundary(buffer);
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary);
        controller.enqueue(encoder.encode(rewriteEventBlock(block, upstream, relayOrigin)));
        boundary = nextBoundary(buffer);
      }

      if (buffer.length > MAX_EVENT_SIZE) {
        controller.error(new Error("SSE event exceeded the relay limit"));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) {
        controller.enqueue(encoder.encode(rewriteEventBlock(buffer, upstream, relayOrigin)));
      }
    },
  });
}
