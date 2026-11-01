import type { Env } from "./env";

export const DEFAULT_ALLOWED_ORIGINS = [
  "https://vscode.dev",
  "https://insiders.vscode.dev",
  "https://github.dev",
  "https://insiders.github.dev",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

export function getAllowedOrigins(env: Env): string[] {
  const configured = env.ALLOWED_ORIGINS?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured?.length ? configured : DEFAULT_ALLOWED_ORIGINS;
}

/**
 * VS Code for the Web serves every editor instance from an ephemeral
 * subdomain such as https://abc123-xyz.vscode-cdn.net. The web extension host
 * and its webviews make their requests from that origin, not from the bare
 * https://vscode.dev origin, so exact matching alone rejects every real
 * vscode.dev session.
 */
const VSCODE_CDN_ORIGIN = /^https:\/\/[a-z0-9-]+\.vscode-cdn\.net$/;

/**
 * `vscode-test-web` runs the web extension host on a subdomain of localhost,
 * for example http://v--abc123.localhost:3000. That is a different origin from
 * http://localhost:3000, so it needs its own pattern. It is gated behind
 * ALLOW_LOCAL_ORIGINS so a public deployment only accepts editor origins.
 */
const VSCODE_LOCAL_ORIGIN = /^http:\/\/v--[a-z0-9-]+\.localhost:\d+$/;

export function isOriginAllowed(origin: string, env: Env): boolean {
  if (getAllowedOrigins(env).includes(origin)) {
    return true;
  }
  if (VSCODE_CDN_ORIGIN.test(origin)) {
    return true;
  }
  return env.ALLOW_LOCAL_ORIGINS === "true" && VSCODE_LOCAL_ORIGIN.test(origin);
}

export function corsHeaders(origin: string | null): Headers {
  const headers = new Headers();
  if (!origin) return headers;

  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Vary", "Origin");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Last-Event-ID, Mcp-Session-Id, Mcp-Protocol-Version",
  );
  headers.set("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}
