import { corsHeaders, isOriginAllowed } from "./cors";
import type { Env } from "./env";
import { createEndpointRewriter } from "./sse";
import { parseUpstreamUrl, UpstreamError } from "./url-policy";

const MAX_BODY_BYTES = 1_048_576;
const USER_AGENT = "mcp-inspector-relay/0.1";

function jsonResponse(status: number, body: unknown, headers: Headers): Response {
  const out = new Headers(headers);
  out.set("Content-Type", "application/json; charset=utf-8");
  out.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: out });
}

function methodNotAllowed(allow: string, headers: Headers): Response {
  const out = new Headers(headers);
  out.set("Allow", allow);
  return jsonResponse(405, { error: "Method not allowed" }, out);
}

function copyHeader(from: Request, to: Headers, name: string): void {
  const value = from.headers.get(name);
  if (value) to.set(name, value);
}

async function proxySse(
  request: Request,
  env: Env,
  relayUrl: URL,
  headers: Headers,
): Promise<Response> {
  const upstream = parseUpstreamUrl(relayUrl.searchParams.get("url"), env);
  const upstreamHeaders = new Headers({
    Accept: "text/event-stream",
    "User-Agent": USER_AGENT,
  });
  copyHeader(request, upstreamHeaders, "authorization");
  copyHeader(request, upstreamHeaders, "last-event-id");
  copyHeader(request, upstreamHeaders, "mcp-session-id");
  copyHeader(request, upstreamHeaders, "mcp-protocol-version");

  const response = await fetch(upstream, {
    method: "GET",
    headers: upstreamHeaders,
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError("Upstream redirected; redirects are not allowed", 502);
  }
  if (!response.ok) {
    throw new UpstreamError(`Upstream returned HTTP ${response.status}`, 502);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new UpstreamError("Upstream did not return an SSE stream", 502);
  }
  if (!response.body) {
    throw new UpstreamError("Upstream returned an empty stream", 502);
  }

  const stream = response.body.pipeThrough(createEndpointRewriter(upstream, relayUrl.origin));
  const out = new Headers(headers);
  out.set("Content-Type", "text/event-stream; charset=utf-8");
  out.set("Cache-Control", "no-cache, no-transform");
  out.set("X-Accel-Buffering", "no");

  return new Response(stream, { status: 200, headers: out });
}

async function proxyMessage(
  request: Request,
  env: Env,
  relayUrl: URL,
  headers: Headers,
): Promise<Response> {
  const upstream = parseUpstreamUrl(relayUrl.searchParams.get("url"), env);

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new UpstreamError("Request body too large", 413);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_BODY_BYTES) {
    throw new UpstreamError("Request body too large", 413);
  }

  const upstreamHeaders = new Headers({
    "Content-Type": request.headers.get("content-type") ?? "application/json",
    Accept: request.headers.get("accept") ?? "application/json, text/event-stream",
    "User-Agent": USER_AGENT,
  });
  copyHeader(request, upstreamHeaders, "authorization");
  copyHeader(request, upstreamHeaders, "last-event-id");
  copyHeader(request, upstreamHeaders, "mcp-session-id");
  copyHeader(request, upstreamHeaders, "mcp-protocol-version");

  const response = await fetch(upstream, {
    method: "POST",
    headers: upstreamHeaders,
    body,
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError("Upstream redirected; redirects are not allowed", 502);
  }

  const out = new Headers(headers);
  for (const name of ["content-type", "cache-control"]) {
    const value = response.headers.get(name);
    if (value) out.set(name, value);
  }

  return new Response(response.body, { status: response.status, headers: out });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const relayUrl = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (origin && !isOriginAllowed(origin, env)) {
      return jsonResponse(403, { error: "Origin not allowed" }, new Headers());
    }

    const headers = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    try {
      if (relayUrl.pathname === "/healthz" && request.method === "GET") {
        return jsonResponse(200, { ok: true }, headers);
      }

      if (relayUrl.pathname === "/" && request.method === "GET") {
        return jsonResponse(
          200,
          {
            name: "mcp-inspector-relay",
            description: "CORS relay for the MCP Inspector VS Code extension.",
            endpoints: {
              sse: "/sse?url=<encoded upstream SSE URL>",
              message: "/message?url=<encoded upstream message URL>",
              health: "/healthz",
            },
          },
          headers,
        );
      }

      if (relayUrl.pathname === "/sse") {
        if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS", headers);
        return await proxySse(request, env, relayUrl, headers);
      }

      if (relayUrl.pathname === "/message") {
        if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS", headers);
        return await proxyMessage(request, env, relayUrl, headers);
      }

      return jsonResponse(404, { error: "Not found" }, headers);
    } catch (error) {
      if (error instanceof UpstreamError) {
        return jsonResponse(error.status, { error: error.message }, headers);
      }
      console.error("relay error:", error instanceof Error ? error.message : error);
      return jsonResponse(502, { error: "Upstream request failed" }, headers);
    }
  },
} satisfies ExportedHandler<Env>;
