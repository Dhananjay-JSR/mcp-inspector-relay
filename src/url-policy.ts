import type { Env } from "./env";

export class UpstreamError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function ipv4Parts(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return numbers;
}

function isPrivateIPv4(host: string): boolean {
  const numbers = ipv4Parts(host);
  if (!numbers) return false;
  const [a, b, c] = numbers;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("::ffff:")) return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  if (/^fe[89ab]/.test(h)) return true;
  if (h.startsWith("2001:db8")) return true;
  return false;
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function isPrivateHost(host: string): boolean {
  if (BLOCKED_HOSTS.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (ipv4Parts(host)) return isPrivateIPv4(host);
  if (host.includes(":")) return isPrivateIPv6(host);
  return false;
}

function hostMatches(host: string, pattern: string): boolean {
  const normalized = pattern.toLowerCase();
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === normalized;
}

/**
 * Validates a user-supplied upstream URL before the relay will talk to it.
 * Public upstreams must be HTTPS on port 443; localhost HTTP is allowed only
 * when ALLOW_INSECURE_UPSTREAM is explicitly enabled.
 */
export function parseUpstreamUrl(raw: string | null, env: Env = {}): URL {
  if (!raw) {
    throw new UpstreamError("Missing url query parameter");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpstreamError("Invalid upstream URL");
  }

  if (url.username || url.password) {
    throw new UpstreamError("Upstream URL must not contain credentials");
  }

  url.hash = "";

  const host = normalizeHost(url.hostname);
  const allowInsecure = env.ALLOW_INSECURE_UPSTREAM === "true";
  const loopback = isLoopback(host);

  if (url.protocol === "http:") {
    if (!allowInsecure || !loopback) {
      throw new UpstreamError("Upstream URL must use https");
    }
  } else if (url.protocol !== "https:") {
    throw new UpstreamError("Upstream URL must use https");
  }

  if (loopback) {
    if (!allowInsecure) {
      throw new UpstreamError("Local upstreams are disabled");
    }
  } else {
    if (url.port && url.port !== "443") {
      throw new UpstreamError("Upstream URL must use port 443");
    }
    if (isPrivateHost(host)) {
      throw new UpstreamError("Upstream host is not allowed");
    }
  }

  const allowedHosts = env.ALLOWED_UPSTREAM_HOSTS?.split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (allowedHosts?.length && !allowedHosts.some((pattern) => hostMatches(host, pattern))) {
    throw new UpstreamError("Upstream host is not in ALLOWED_UPSTREAM_HOSTS");
  }

  return url;
}
