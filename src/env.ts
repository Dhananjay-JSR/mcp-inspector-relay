export interface Env {
  /** Comma-separated browser origins allowed to call the relay. */
  ALLOWED_ORIGINS?: string;
  /** Set to "true" to allow the vscode-test-web localhost subdomain origins. */
  ALLOW_LOCAL_ORIGINS?: string;
  /** Optional comma-separated allowlist of upstream hosts (exact or *.suffix). */
  ALLOWED_UPSTREAM_HOSTS?: string;
  /** Set to "true" to allow http:// localhost upstreams during development. */
  ALLOW_INSECURE_UPSTREAM?: string;
}
