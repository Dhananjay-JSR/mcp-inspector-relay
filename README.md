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
| `GET /healthz` | Health check |
| `GET /` | Service metadata |

Both the legacy SSE transport and Streamable HTTP are supported.

## Security model

- HTTPS upstreams only. `http://localhost` is allowed only when
  `ALLOW_INSECURE_UPSTREAM=true`, for development.
- Blocks private, loopback, link-local, CGNAT, documentation and cloud metadata
  hostnames and IP literals.
- Rejects credentials in upstream URLs and non-443 ports.
- Optional `ALLOWED_UPSTREAM_HOSTS` allowlist, supporting `*.suffix` entries.
- `Origin` allowlist defaults to `vscode.dev`, `github.dev`, and localhost dev.
- Request bodies are capped at 1 MiB. Redirects are never followed.
- Forwards `Authorization` and MCP headers but never stores or logs them.

This is an open proxy for allowed upstreams. If you deploy it publicly, add a
Cloudflare rate-limit/WAF rule and consider setting `ALLOWED_UPSTREAM_HOSTS`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `ALLOWED_ORIGINS` | vscode.dev, github.dev, localhost | Browser origins allowed to call the relay |
| `ALLOWED_UPSTREAM_HOSTS` | unset (all public hosts) | Upstream host allowlist |
| `ALLOW_INSECURE_UPSTREAM` | unset | `true` allows `http://localhost` during development |

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
