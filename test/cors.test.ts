import { describe, expect, it } from "vitest";
import { DEFAULT_ALLOWED_ORIGINS, corsHeaders, getAllowedOrigins, isOriginAllowed } from "../src/cors";

describe("cors", () => {
  it("allows the VS Code web origins by default", () => {
    expect(isOriginAllowed("https://vscode.dev", {})).toBe(true);
    expect(isOriginAllowed("https://github.dev", {})).toBe(true);
    expect(isOriginAllowed("https://evil.example", {})).toBe(false);
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
