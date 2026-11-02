import { afterEach, describe, expect, it, vi } from "vitest";
import relay from "../src/index";

const env = { ALLOWED_ORIGINS: "https://vscode.dev" };

function stubUpstream(body: string, contentType = "text/plain") {
  const fetchMock = vi.fn(
    async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": contentType, "content-length": String(body.length) },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PR preview proxy", () => {
  it("serves the manifest with JSON, CORS, and CORP", async () => {
    const body = '{"name":"mcp--inspector"}';
    const fetchMock = stubUpstream(body);

    const response = await relay.fetch(
      new Request("https://relay.example/preview/pr-42/package.json"),
      env,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/Dhananjay-JSR/mcp-inspector/gh-pages/pr-42/package.json",
      expect.objectContaining({ method: "GET" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await response.text()).toBe(body);
  });

  it("serves JavaScript with a worker-safe content type", async () => {
    stubUpstream("self.onmessage = () => {};");

    const response = await relay.fetch(
      new Request("https://relay.example/preview/pr-42/dist/web/extension.js"),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");
  });

  it("serves icons with an image content type", async () => {
    stubUpstream("<svg></svg>");

    const response = await relay.fetch(
      new Request("https://relay.example/preview/pr-42/resources/icon.svg"),
      env,
    );

    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
  });

  it("allows preflight from any origin", async () => {
    const response = await relay.fetch(
      new Request("https://relay.example/preview/pr-42/package.json", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example" },
      }),
      env,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
  });

  it("rejects traversal, empty segments, and non-preview paths", async () => {
    const fetchMock = stubUpstream("secret");

    for (const path of [
      "/preview/pr-42/%2e%2e/secret",
      "/preview/pr-42//package.json",
      "/preview/pr-42/",
      "/preview/notes/package.json",
      "/preview/pr-42",
    ]) {
      const response = await relay.fetch(new Request(`https://relay.example${path}`), env);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a preview error when the upstream is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );

    const response = await relay.fetch(
      new Request("https://relay.example/preview/pr-99/package.json"),
      env,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
    expect(await response.json()).toEqual({ error: "Preview not found" });
  });

  it("rejects unsupported methods", async () => {
    const response = await relay.fetch(
      new Request("https://relay.example/preview/pr-42/package.json", { method: "POST" }),
      env,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
  });

  it("supports HEAD without a body", async () => {
    stubUpstream("body");

    const response = await relay.fetch(
      new Request("https://relay.example/preview/pr-42/package.json", { method: "HEAD" }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json; charset=utf-8");
    expect(await response.text()).toBe("");
  });

  it("uses configured repository and branch names", async () => {
    const fetchMock = stubUpstream("{}");

    await relay.fetch(
      new Request("https://relay.example/preview/pr-7/package.json"),
      { PREVIEW_REPO: "example/previews", PREVIEW_BRANCH: "previews" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/example/previews/previews/pr-7/package.json",
      expect.objectContaining({ method: "GET" }),
    );
  });
});
