import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_ORIGINS, corsHeaders, getAllowedOrigins, isOriginAllowed } from "../src/cors";

describe("cors", () => {
  it("allows the VS Code web origins by default", () => {
    expect(isOriginAllowed("https://vscode.dev", {})).toBe(true);
    expect(isOriginAllowed("https://github.dev", {})).toBe(true);
    expect(isOriginAllowed("https://evil.example", {})).toBe(false);
  });

  it("allows the ephemeral vscode-cdn origin used by VS Code for the Web", () => {
    expect(isOriginAllowed("https://dhananjaay-gsmpk.vscode-cdn.net", {})).toBe(true);
    expect(isOriginAllowed("https://abc123.vscode-cdn.net", {})).toBe(true);
    // Still a closed pattern: exact hosts only, no lookalikes.
    expect(isOriginAllowed("https://vscode-cdn.net", {})).toBe(false);
    expect(isOriginAllowed("https://abc.vscode-cdn.net.evil.example", {})).toBe(false);
    expect(isOriginAllowed("http://abc.vscode-cdn.net", {})).toBe(false);
    expect(isOriginAllowed("https://abc.vscode-cdn.net:8443", {})).toBe(false);
  });

  it("gates vscode-test-web localhost subdomains behind ALLOW_LOCAL_ORIGINS", () => {
    const origin =
      "http://v--1on1tlku1l82k04sa244ng64fq8ph7hucgciav84f2tqdkvkrdb9.localhost:3000";
    expect(isOriginAllowed(origin, {})).toBe(false);
    expect(isOriginAllowed(origin, { ALLOW_LOCAL_ORIGINS: "true" })).toBe(true);
    expect(
      isOriginAllowed("http://v--abc.localhost.evil.example:3000", {
        ALLOW_LOCAL_ORIGINS: "true",
      }),
    ).toBe(false);
    expect(
      isOriginAllowed("https://v--abc.localhost:3000", { ALLOW_LOCAL_ORIGINS: "true" }),
    ).toBe(false);
  });

  it("uses a configured origin list when provided", () => {
    const env = { ALLOWED_ORIGINS: "https://example.com, https://other.example" };
    expect(getAllowedOrigins(env)).toEqual(["https://example.com", "https://other.example"]);
    expect(isOriginAllowed("https://example.com", env)).toBe(true);
    expect(isOriginAllowed("https://vscode.dev", env)).toBe(false);
  });

  it("emits the MCP CORS headers for an allowed origin", () => {
    const headers = corsHeaders("https://vscode.dev");
    expect(headers.get("Access-Control-Allow-Origin")).toBe("https://vscode.dev");
    expect(headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, DELETE, OPTIONS");
    expect(headers.get("Access-Control-Allow-Headers")).toContain("Mcp-Session-Id");
    expect(headers.get("Access-Control-Expose-Headers")).toContain("Mcp-Session-Id");
    expect(headers.get("Vary")).toBe("Origin");
  });

  it("emits no CORS headers without an origin", () => {
    expect([...corsHeaders(null).keys()]).toEqual([]);
  });

  it("has sane defaults", () => {
    expect(DEFAULT_ALLOWED_ORIGINS).toContain("https://vscode.dev");
  });
});
