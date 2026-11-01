import { corsHeaders, isAllowedRedirectTarget, isOriginAllowed } from "./cors";
import type { Env } from "./env";
import { createEndpointRewriter } from "./sse";
import { parseUpstreamUrl, UpstreamError } from "./url-policy";

const MAX_BODY_BYTES = 1_048_576;
const USER_AGENT = "mcp-inspector-relay/0.1";

/**
 * Request headers the relay forwards upstream. Everything else is dropped so a
 * browser cannot smuggle host, cookie, or proxy headers through the relay.
 * Authorization carries the user's bearer token; the relay never logs it.
 */
const FORWARDED_REQUEST_HEADERS = [
  "authorization",
  "accept",
  "content-type",
  "last-event-id",
  "mcp-session-id",
  "mcp-protocol-version",
] as const;

const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "cache-control",
  "mcp-session-id",
  "mcp-protocol-version",
] as const;

/**
 * OAuth requests need only these headers. MCP-specific headers are dropped so a
 * discovery or token request cannot fail on an authorization server that does
 * not allow them.
 */
const FORWARDED_AUTH_REQUEST_HEADERS = ["accept", "authorization", "content-type"] as const;

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

/**
 * Cloudflare's rate limiting bindings are approximate and per-location, but
 * they stop one client from using the relay as a bulk proxy. The key combines
 * the client IP with the browser origin so separate sessions get separate
 * budgets, and OAuth endpoints get a tighter limit than the transport.
 */
function rateLimitKey(request: Request, bucket: "auth" | "api"): string {
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const origin = request.headers.get("Origin") ?? "direct";
  return `${bucket}|${ip}|${origin}`;
}

async function enforceRateLimit(
  request: Request,
  env: Env,
  path: string,
): Promise<Response | null> {
  const authPath =
    path === "/auth" ||
    path === OAUTH_CALLBACK_PATH ||
    path.startsWith(`${OAUTH_CALLBACK_PATH}/`);
  const bucket = authPath ? "auth" : "api";
  const limiter = bucket === "auth" ? env.AUTH_RATE_LIMITER : env.API_RATE_LIMITER;
  if (!limiter) {
    return null;
  }

  const { success } = await limiter.limit({ key: rateLimitKey(request, bucket) });
  if (success) {
    return null;
  }

  const headers = corsHeaders(request.headers.get("Origin"));
  headers.set("Retry-After", bucket === "auth" ? "60" : "10");
  return jsonResponse(429, { error: "Rate limit exceeded" }, headers);
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

/**
 * Receives the authorization redirect at a stable HTTPS URL and forwards the
 * code/state to the VS Code URI handler. This avoids authorization servers
 * that reject the editor's ephemeral callback URL.
 */
const OAUTH_CALLBACK_PATH = "/oauth/callback";

/**
 * The target travels in the callback path as base64url. Encoding it as a query
 * parameter produces nested, double-encoded URLs, and some authorization
 * servers reject those when they complete the flow.
 */
function decodeCallbackTarget(token: string): string | null {
  try {
    const base64 = token.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function oauthCallbackResponse(relayUrl: URL, env: Env, headers: Headers): Response {
  const pathToken = relayUrl.pathname.startsWith(`${OAUTH_CALLBACK_PATH}/`)
    ? relayUrl.pathname.slice(OAUTH_CALLBACK_PATH.length + 1)
    : "";
  const target = pathToken
    ? decodeCallbackTarget(pathToken)
    : relayUrl.searchParams.get("target");
  if (!target || !isAllowedRedirectTarget(target, env)) {
    return jsonResponse(400, { error: "Redirect target not allowed" }, headers);
  }

  const url = new URL(target);
  for (const name of ["code", "state", "error", "error_description"]) {
    const value = relayUrl.searchParams.get(name);
    if (value !== null) {
      url.searchParams.set(name, value);
    }
  }

  const out = new Headers(headers);
  out.set("Location", url.toString());
  out.set("Cache-Control", "no-store");
  // The callback URL carries the authorization code. Do not let the browser
  // send it to VS Code (or anyone else) in a Referer header.
  out.set("Referrer-Policy", "no-referrer");
  return new Response(null, { status: 302, headers: out });
}

/**
 * Proxies an OAuth endpoint (protected-resource metadata, authorization-server
 * metadata, dynamic registration, or the token exchange). Some authorization
 * servers send correct CORS headers on preflight but omit them from the real
 * response, which makes the browser discard it. Relaying the request gives the
 * browser a response the relay owns, so it can always attach CORS headers.
 *
 * The relay sees the authorization code and token response while proxying, so
 * this endpoint is only used when the user opts into the relay.
 */
async function proxyAuth(
  request: Request,
  env: Env,
  relayUrl: URL,
  headers: Headers,
): Promise<Response> {
  const upstream = parseUpstreamUrl(relayUrl.searchParams.get("url"), env);

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      throw new UpstreamError("Request body too large", 413);
    }

    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      throw new UpstreamError("Request body too large", 413);
    }
  }

  const upstreamHeaders = new Headers({ "User-Agent": USER_AGENT });
  for (const name of FORWARDED_AUTH_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  if (!upstreamHeaders.has("accept")) {
    upstreamHeaders.set("Accept", "application/json");
  }

  const response = await fetch(upstream, {
    method: request.method,
    headers: upstreamHeaders,
    body,
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError("Upstream redirected; redirects are not allowed", 502);
  }

  const out = new Headers(headers);
  const contentType = response.headers.get("content-type");
  if (contentType) out.set("Content-Type", contentType);
  out.set("Cache-Control", "no-store");

  return new Response(response.body, { status: response.status, headers: out });
}

/**
 * Proxies a Streamable HTTP endpoint. Unlike legacy SSE there is no endpoint
 * event to rewrite: the client keeps using the same relay URL for POST, GET,
 * and DELETE, and the relay forwards each request to the upstream `url`.
 */
async function proxyStreamableHttp(
  request: Request,
  env: Env,
  relayUrl: URL,
  headers: Headers,
): Promise<Response> {
  const upstream = parseUpstreamUrl(relayUrl.searchParams.get("url"), env);

  let body: ArrayBuffer | undefined;
  if (request.method === "POST") {
    const declaredLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      throw new UpstreamError("Request body too large", 413);
    }

    body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      throw new UpstreamError("Request body too large", 413);
    }
  }

  const upstreamHeaders = new Headers({ "User-Agent": USER_AGENT });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    copyHeader(request, upstreamHeaders, name);
  }
  if (request.method === "POST" && !upstreamHeaders.has("accept")) {
    upstreamHeaders.set("Accept", "application/json, text/event-stream");
  }

  const response = await fetch(upstream, {
    method: request.method,
    headers: upstreamHeaders,
    body,
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    throw new UpstreamError("Upstream redirected; redirects are not allowed", 502);
  }

  const out = new Headers(headers);
  for (const name of FORWARDED_RESPONSE_HEADERS) {
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

      const limited = await enforceRateLimit(request, env, relayUrl.pathname);
      if (limited) {
        return limited;
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
              streamableHttp: "/mcp?url=<encoded upstream Streamable HTTP URL>",
              oauth: "/auth?url=<encoded OAuth endpoint URL>",
              oauthCallback: "/oauth/callback/<base64url VS Code URI>",
              health: "/healthz",
            },
          },
          headers,
        );
      }

      if (
        relayUrl.pathname === OAUTH_CALLBACK_PATH ||
        relayUrl.pathname.startsWith(`${OAUTH_CALLBACK_PATH}/`)
      ) {
        if (request.method !== "GET") {
          return methodNotAllowed("GET, OPTIONS", headers);
        }
        return oauthCallbackResponse(relayUrl, env, headers);
      }

      if (relayUrl.pathname === "/auth") {
        if (!["GET", "POST"].includes(request.method)) {
          return methodNotAllowed("GET, POST, OPTIONS", headers);
        }
        return await proxyAuth(request, env, relayUrl, headers);
      }

      if (relayUrl.pathname === "/sse") {
        if (request.method !== "GET") return methodNotAllowed("GET, OPTIONS", headers);
        return await proxySse(request, env, relayUrl, headers);
      }

      if (relayUrl.pathname === "/message") {
        if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS", headers);
        return await proxyMessage(request, env, relayUrl, headers);
      }

      if (relayUrl.pathname === "/mcp") {
        if (!["GET", "POST", "DELETE"].includes(request.method)) {
          return methodNotAllowed("GET, POST, DELETE, OPTIONS", headers);
        }
        return await proxyStreamableHttp(request, env, relayUrl, headers);
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
