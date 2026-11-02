import type { Env } from "./env";

const PREVIEW_PREFIX = "/preview/";
const DEFAULT_REPO = "Dhananjay-JSR/mcp-inspector";
const DEFAULT_BRANCH = "gh-pages";
const SAFE_PREVIEW_PATH = /^pr-\d+\/[A-Za-z0-9._/-]+$/;

const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

export function isPreviewPath(pathname: string): boolean {
  return pathname.startsWith(PREVIEW_PREFIX);
}

/**
 * vscode.dev runs cross-origin isolated: extension resources need CORS and
 * Cross-Origin-Resource-Policy. The relay owns these headers so the preview can
 * sit behind a stable URL without the `@branch` segment that URI.parse encodes.
 */
export function previewHeaders(): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "no-store");
  return headers;
}

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf(".");
  const extension = dot >= 0 ? path.slice(dot) : "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

function previewError(status: number, message: string): Response {
  const headers = previewHeaders();
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

/**
 * Serves the preview files committed to the extension repository's gh-pages
 * branch. Raw GitHub returns text/plain for JavaScript, so the content type is
 * derived from the requested path instead of trusted upstream.
 */
export async function proxyPreview(
  request: Request,
  env: Env,
  relayUrl: URL,
): Promise<Response> {
  const relative = relayUrl.pathname.slice(PREVIEW_PREFIX.length);
  if (
    !SAFE_PREVIEW_PATH.test(relative) ||
    relative.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return previewError(404, "Preview not found");
  }

  const repo = env.PREVIEW_REPO ?? DEFAULT_REPO;
  const branch = env.PREVIEW_BRANCH ?? DEFAULT_BRANCH;
  const upstream = `https://raw.githubusercontent.com/${repo}/${branch}/${relative}`;

  const response = await fetch(upstream, {
    method: request.method === "HEAD" ? "HEAD" : "GET",
    redirect: "manual",
    headers: { "User-Agent": "mcp-inspector-relay/0.1" },
  });

  if (response.status === 404) {
    return previewError(404, "Preview not found");
  }
  if (response.status >= 300 && response.status < 400) {
    return previewError(502, "Preview upstream redirected");
  }
  if (!response.ok) {
    return previewError(502, `Preview upstream returned ${response.status}`);
  }

  const headers = previewHeaders();
  headers.set("Content-Type", contentTypeFor(relative));
  const length = response.headers.get("content-length");
  if (length) {
    headers.set("Content-Length", length);
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: 200, headers });
  }
  return new Response(response.body, { status: 200, headers });
}
