# MCP Inspector Relay

A small CORS relay that lets the [MCP Inspector](https://github.com/Dhananjay-JSR/mcp-inspector)
extension connect to remote MCP servers from **VS Code for the Web**
(`vscode.dev`, `github.dev`).

## Why this exists

VS Code for the Web runs extensions in a browser Web Worker, so every request is
subject to the browser's same-origin policy. Most MCP servers do not send CORS
headers that allow `https://vscode.dev`, and the browser blocks the request before
it is sent.

This relay sits between the browser and the MCP server, adds the required CORS
headers, and forwards the legacy SSE stream. The extension needs no relay-specific
code: you point it at a relay URL.

## Usage

The public instance runs at `https://mcp-relay.dhananjaay.dev`. In MCP
Inspector choose **SSE** and enter:

```text
https://mcp-relay.dhananjaay.dev/sse?url=https%3A%2F%2Fmcp.example.com%2Fsse
```

The `url` value must be URL-encoded:

```js
const relayUrl = `https://mcp-relay.dhananjaay.dev/sse?url=${encodeURIComponent("https://mcp.example.com/sse")}`;
```

For a **Streamable HTTP** server, choose that transport and use `/mcp`:

```text
https://mcp-relay.dhananjaay.dev/mcp?url=https%3A%2F%2Fmcp.example.com%2Fmcp
```

The same relay URL handles the `POST`, `GET`, and `DELETE` requests that the
Streamable HTTP transport uses, and session headers (`Mcp-Session-Id`,
`Mcp-Protocol-Version`) are passed through in both directions.

Self-hosting? Replace the host with your own deployment.

The relay rewrites the MCP `endpoint` event so tool calls flow back through the
relay automatically.

### Bearer tokens

Send `Authorization: Bearer <token>` with the request. The relay forwards it
upstream on every request, so a protected server works without exposing the
token to the page. It is never logged or stored.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /sse?url=` | Proxies the upstream SSE stream and rewrites the endpoint event |
| `POST /message?url=` | Proxies client JSON-RPC messages to the upstream message URL |
| `GET/POST/DELETE /mcp?url=` | Proxies a Streamable HTTP session |
| `GET/POST /auth?url=` | Proxies an OAuth discovery, registration, or token endpoint |
| `GET /oauth/callback/<target>` | Receives the authorization redirect and forwards it to VS Code |
| `GET /healthz` | Health check |
| `GET /` | Service metadata |

Both the legacy SSE transport and Streamable HTTP are supported.

## OAuth endpoints

Some authorization servers send the correct CORS headers on the preflight
request but omit them from the real response. The browser then discards the
response, so discovery, dynamic client registration, or the token exchange fail
even though the server looks CORS-enabled.

`/auth?url=` proxies those requests so the browser always receives a response
with CORS headers. The extension uses it only when the user connects through the
relay:

```text
https://mcp-relay.dhananjaay.dev/auth?url=https%3A%2F%2Fmcp-auth.example.com%2Foauth2%2Ftoken
```

The relay forwards `Accept`, `Content-Type`, and `Authorization`, drops cookies
and MCP headers, and never follows redirects. Because it sits in the token
exchange, it can see the authorization code and the token response; it does not
log either.

`/oauth/callback` gives the authorization server a stable HTTPS redirect URI
when it rejects the editor's ephemeral callback URL:

```text
https://mcp-relay.dhananjaay.dev/oauth/callback/<base64url VS Code URI>
```

The target is base64url-encoded in the path instead of a query parameter. Some
authorization servers reject a redirect URI whose query contains another
URL, and a nested query has to be double-encoded to survive the round trip.

The relay appends the returned `code`/`state` to the decoded target and
redirects. The target must be a VS Code origin or the inspector's `vscode://`
URI, so the relay cannot be used as an open redirect.

## Security model

- HTTPS upstreams only. `http://localhost` is allowed only when
  `ALLOW_INSECURE_UPSTREAM=true`, for development.
- Blocks private, loopback, link-local, CGNAT, documentation and cloud metadata
  hostnames and IP literals.
- Rejects credentials in upstream URLs and non-443 ports.
- Optional `ALLOWED_UPSTREAM_HOSTS` allowlist, supporting `*.suffix` entries.
- `Origin` allowlist defaults to `vscode.dev`, `github.dev`, and localhost dev,
  plus the per-session `*.vscode-cdn.net` origin VS Code for the Web actually
  uses. The `vscode-test-web` localhost subdomains are allowed only when
  `ALLOW_LOCAL_ORIGINS=true`.
- Request bodies are capped at 1 MiB. Redirects are never followed.
- Forwards `Authorization` and MCP headers but never stores or logs them.
- `/auth` sees OAuth codes and token responses while proxying; it does not log
  bodies, headers, or tokens.
- Logs only generic error messages: no request or response bodies, headers, URLs
  with secrets, or tokens.
- Rate limits are enforced with the Workers rate limiting binding, keyed by
  client IP and browser origin: 60 requests per minute for OAuth endpoints and
  600 per minute for the transport. Limits are approximate and counted per
  Cloudflare location.
- The OAuth callback answers with `Referrer-Policy: no-referrer`, so the browser
  never sends the authorization code to VS Code (or anyone else) in a
  `Referer` header.
- The callback target must be a VS Code origin or the inspector's `vscode://`
  authority; the relay cannot be used as an open redirect.

### SSRF and DNS

Upstream hostnames are validated before the relay calls `fetch`: HTTPS only,
port 443, no credentials, and no private, loopback, link-local, CGNAT,
documentation, multicast, 6to4, Teredo, NAT64 or cloud metadata addresses. The
check runs on the URL host, not on a DNS answer, so a public hostname that
resolves to a private address is only stopped by the platform: Cloudflare
Workers cannot reach private network destinations. For a stricter deployment,
set `ALLOWED_UPSTREAM_HOSTS` to the exact hosts you intend to serve.

| Area | Protection |
| --- | --- |
| Upstream URL | HTTPS and port 443 only |
| SSRF | Private/reserved host and IP validation; optional host allowlist |
| Redirects | `redirect: "manual"`, any 3xx becomes `502` |
| Callback target | VS Code origin / `vscode://` authority allowlist |
| OAuth state | 128-bit secure random, validated by the extension |
| PKCE | `S256`; verifier stored by the extension |
| Tokens | Never stored, cached, or logged by the relay |
| Headers | Explicit request/response allowlists; cookies dropped |
| Rate limiting | Workers binding, per IP + origin, separate OAuth and transport limits |

This is an open proxy for allowed upstreams. If you deploy it publicly, keep the
rate limits enabled and consider setting `ALLOWED_UPSTREAM_HOSTS`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | vscode.dev, github.dev, localhost | Browser origins allowed to call the relay |
| `ALLOW_LOCAL_ORIGINS` | unset | `true` allows the `vscode-test-web` `*.localhost` subdomains |
| `ALLOWED_UPSTREAM_HOSTS` | unset (all public hosts) | Upstream host allowlist |
| `ALLOW_INSECURE_UPSTREAM` | unset | `true` allows `http://localhost` during development |
| `AUTH_RATE_LIMITER` | binding, 60/min | OAuth discovery, registration, token, callback |
| `API_RATE_LIMITER` | binding, 600/min | MCP transport endpoints |

## Development

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run check
```

`npm run dev` starts a local Worker. To test the full flow, run a local MCP SSE
server and allow insecure upstreams in `.dev.vars`:

```dotenv
ALLOW_INSECURE_UPSTREAM=true
ALLOW_LOCAL_ORIGINS=true
ALLOWED_ORIGINS=https://vscode.dev,http://localhost:3000
```

Then use `http://localhost:8787/sse?url=http%3A%2F%2Flocalhost%3A3001%2Fsse`.

## Deployment

The relay is deployed at `https://mcp-relay.dhananjaay.dev` (a Cloudflare custom
domain).

Pushes to `main` deploy automatically after CI passes, provided these repository
secrets are set:

- `CLOUDFLARE_API_TOKEN` — an API token with **Edit Cloudflare Workers** scoped to
  this account
- `CLOUDFLARE_ACCOUNT_ID`

Create the token under **Cloudflare dashboard → Account API tokens → Create
Token → Edit Cloudflare Workers**, scoped to the account that owns the Worker.
The workflow also supports manual runs from the Actions tab.

Local deploys:

```bash
npx wrangler login
npm run deploy
```

## License

MIT
