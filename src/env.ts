export interface Env {
  /** Comma-separated browser origins allowed to call the relay. */
  ALLOWED_ORIGINS?: string;
  /** Set to "true" to allow the vscode-test-web localhost subdomain origins. */
  ALLOW_LOCAL_ORIGINS?: string;
  /** Optional comma-separated allowlist of upstream hosts (exact or *.suffix). */
  ALLOWED_UPSTREAM_HOSTS?: string;
  /** Set to "true" to allow http:// localhost upstreams during development. */
  ALLOW_INSECURE_UPSTREAM?: string;
  /** Per-client limit for OAuth discovery, registration, token, and callback. */
  AUTH_RATE_LIMITER?: RateLimit;
  /** Per-client limit for the MCP transport endpoints. */
  API_RATE_LIMITER?: RateLimit;
}
