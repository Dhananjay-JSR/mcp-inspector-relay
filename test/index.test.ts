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

  it("answers health checks", async () => {
    const response = await relay.fetch(new Request("https://relay.example/healthz"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
