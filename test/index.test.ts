import { afterEach, describe, expect, it, vi } from "vitest";
import relay from "../src/index";

const env = { ALLOWED_ORIGINS: "https://vscode.dev" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("relay worker", () => {
  it("rewrites the SSE endpoint and sets CORS", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("event: endpoint\ndata: /messages?sessionId=abc\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );

    const request = new Request(
      "https://relay.example/sse?url=https%3A%2F%2Fmcp.example.com%2Fsse",
      { headers: { Origin: "https://vscode.dev" } },
    );
    const response = await relay.fetch(request, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://vscode.dev");
    const text = await response.text();
    expect(text).toContain("https://relay.example/message?url=");
  });

  it("rejects disallowed origins", async () => {
    const request = new Request("https://relay.example/healthz", {
      headers: { Origin: "https://evil.example" },
    });
    const response = await relay.fetch(request, env);

    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("proxies messages to the upstream", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("{}", {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request(
      "https://relay.example/message?url=https%3A%2F%2Fmcp.example.com%2Fmessages%3FsessionId%3Dabc",
      {
        method: "POST",
        headers: { Origin: "https://vscode.dev", "Content-Type": "application/json" },
        body: '{"jsonrpc":"2.0"}',
      },
    );
    const response = await relay.fetch(request, env);

    expect(response.status).toBe(202);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://vscode.dev");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("proxies an OAuth registration POST with CORS and strips MCP headers", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ client_id: "client-123" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request(
      "https://relay.example/auth?url=https%3A%2F%2Fauth.example.com%2Foauth2%2Fregister",
      {
        method: "POST",
        headers: {
          Origin: "https://vscode.dev",
          "Content-Type": "application/json",
          "Mcp-Protocol-Version": "2025-06-18",
          Cookie: "session=should-not-be-forwarded",
        },
        body: '{"client_name":"MCP Inspector"}',
      },
    );

    const response = await relay.fetch(request, env);

    expect(response.status).toBe(201);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://vscode.dev");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ client_id: "client-123" });

    const [, init] = fetchMock.mock.calls[0];
    const forwarded = new Headers(init?.headers);
    expect(forwarded.get("content-type")).toBe("application/json");
    expect(forwarded.get("mcp-protocol-version")).toBeNull();
    expect(forwarded.get("cookie")).toBeNull();
    expect(init?.redirect).toBe("manual");
  });

  it("proxies OAuth discovery GET with CORS", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ issuer: "https://auth.example.com" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const request = new Request(
      "https://relay.example/auth?url=https%3A%2F%2Fauth.example.com%2F.well-known%2Foauth-authorization-server",
      { headers: { Origin: "https://vscode.dev" } },
    );

    const response = await relay.fetch(request, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://vscode.dev");
    expect(await response.json()).toEqual({ issuer: "https://auth.example.com" });
  });

  it("does not follow redirects on OAuth endpoints", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.example" },
          }),
      ),
    );

    const request = new Request(
      "https://relay.example/auth?url=https%3A%2F%2Fauth.example.com%2Foauth2%2Ftoken",
      {
        method: "POST",
        headers: { Origin: "https://vscode.dev", "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=authorization_code&code=abc",
      },
    );

    const response = await relay.fetch(request, env);

    expect(response.status).toBe(502);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://vscode.dev");
  });

  it("redirects the OAuth callback to an allowed VS Code target", async () => {
    const request = new Request(
      "https://relay.example/oauth/callback?target=https%3A%2F%2Fvscode.dev%2Fredirect%3Fx%3D1&code=abc&state=s",
      { headers: { Origin: "https://vscode.dev" } },
    );

    const response = await relay.fetch(request, env);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://vscode.dev/redirect?x=1&code=abc&state=s",
    );
  });

  it("redirects a path-encoded OAuth callback target", async () => {
    const target = "https://vscode.dev/redirect?vscode-reqid=2&vscode-path=%2Fmcp-oauth-callback";
    const token = Buffer.from(target, "utf8").toString("base64url");
    const request = new Request(
      `https://relay.example/oauth/callback/${token}?code=abc&state=s`,
      { headers: { Origin: "https://vscode.dev" } },
    );

    const response = await relay.fetch(request, env);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(
      "https://vscode.dev/redirect?vscode-reqid=2&vscode-path=%2Fmcp-oauth-callback&code=abc&state=s",
    );
  });

  it("rejects a path-encoded OAuth callback to an unallowed target", async () => {
    const token = Buffer.from("https://evil.example/cb", "utf8").toString("base64url");
    const request = new Request(`https://relay.example/oauth/callback/${token}?code=abc`, {
      headers: { Origin: "https://vscode.dev" },
    });

    const response = await relay.fetch(request, env);

    expect(response.status).toBe(400);
  });

  it("rejects an OAuth callback to an unallowed target", async () => {
    const request = new Request(
      "https://relay.example/oauth/callback?target=https%3A%2F%2Fevil.example%2Fcb&code=abc",
      { headers: { Origin: "https://vscode.dev" } },
    );

    const response = await relay.fetch(request, env);

    expect(response.status).toBe(400);
  });

  it("allows the inspector's vscode URI as a callback target", async () => {
    const target = "vscode://DhananjaySenday.mcp--inspector/mcp-oauth-callback";
    const request = new Request(
      `https://relay.example/oauth/callback?target=${encodeURIComponent(target)}&code=abc&state=s`,
      { headers: { Origin: "https://vscode.dev" } },
    );

    const response = await relay.fetch(request, env);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(`${target}?code=abc&state=s`);
  });

  it("rate limits OAuth endpoints with a Retry-After header", async () => {
    const keys: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    };

    const request = new Request(
      "https://relay.example/auth?url=https%3A%2F%2Fauth.example.com%2Foauth2%2Ftoken",
      {
        method: "POST",
        headers: {
          Origin: "https://vscode.dev",
          "CF-Connecting-IP": "203.0.113.9",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=authorization_code&code=abc",
      },
    );

    const response = await relay.fetch(request, { ...env, AUTH_RATE_LIMITER: limiter });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://vscode.dev");
    expect(keys[0]).toBe("auth|203.0.113.9|https://vscode.dev");
  });

  it("uses the API limiter for transport and skips health checks", async () => {
    const calls: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        calls.push(key);
        return { success: true };
      },
    };

    const health = await relay.fetch(new Request("https://relay.example/healthz"), {
      ...env,
      AUTH_RATE_LIMITER: limiter,
      API_RATE_LIMITER: limiter,
    });
    expect(health.status).toBe(200);
    expect(calls).toHaveLength(0);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const transport = await relay.fetch(
      new Request("https://relay.example/mcp?url=https%3A%2F%2Fmcp.example.com%2Fmcp", {
        method: "POST",
        headers: {
          Origin: "https://vscode.dev",
          "CF-Connecting-IP": "203.0.113.9",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      { ...env, API_RATE_LIMITER: limiter },
    );
    expect(transport.status).toBe(200);
    expect(calls[0]).toBe("api|203.0.113.9|https://vscode.dev");
  });

  it("answers health checks", async () => {
    const response = await relay.fetch(new Request("https://relay.example/healthz"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("proxies a Streamable HTTP POST and forwards the bearer token", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "session-123",
            "mcp-protocol-version": "2025-06-18",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = new Request(
      "https://relay.example/mcp?url=https%3A%2F%2Fmcp.example.com%2Fmcp",
      {
        method: "POST",
        headers: {
          Origin: "https://vscode.dev",
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer secret-token",
          Cookie: "session=should-not-be-forwarded",
        },
        body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
      },
    );

    const response = await relay.fetch(request, env);

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://vscode.dev");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Mcp-Session-Id");
    expect(response.headers.get("Mcp-Session-Id")).toBe("session-123");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    const forwarded = new Headers(init?.headers);
    expect(forwarded.get("authorization")).toBe("Bearer secret-token");
    expect(forwarded.get("cookie")).toBeNull();
    expect(init?.redirect).toBe("manual");
  });

  it("streams a Streamable HTTP GET response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("event: message\ndata: {}\n\n", {
            status: 200,
            headers: { "content-type": "text/event-stream", "mcp-session-id": "session-123" },
          }),
      ),
    );

    const response = await relay.fetch(
      new Request("https://relay.example/mcp?url=https%3A%2F%2Fmcp.example.com%2Fmcp", {
        headers: { Origin: "https://vscode.dev", Accept: "text/event-stream" },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("Mcp-Session-Id")).toBe("session-123");
  });

  it("proxies a Streamable HTTP DELETE for session termination", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await relay.fetch(
      new Request("https://relay.example/mcp?url=https%3A%2F%2Fmcp.example.com%2Fmcp", {
        method: "DELETE",
        headers: { Origin: "https://vscode.dev", "Mcp-Session-Id": "session-123" },
      }),
      env,
    );

    expect(response.status).toBe(204);
    const [, init] = fetchMock.mock.calls[0];
    expect(new Headers(init?.headers).get("mcp-session-id")).toBe("session-123");
  });

  it("rejects unsupported methods on the Streamable HTTP endpoint", async () => {
    const response = await relay.fetch(
      new Request("https://relay.example/mcp?url=https%3A%2F%2Fmcp.example.com%2Fmcp", {
        method: "PUT",
        headers: { Origin: "https://vscode.dev" },
      }),
      env,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toContain("DELETE");
  });
});
