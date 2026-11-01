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

export function isOriginAllowed(origin: string, env: Env): boolean {
  return getAllowedOrigins(env).includes(origin);
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
