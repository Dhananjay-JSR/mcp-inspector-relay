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

Self-hosting? Replace the host with your own deployment.

The relay rewrites the MCP `endpoint` event so tool calls flow back through the
relay automatically.

## Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /sse?url=` | Proxies the upstream SSE stream and rewrites the endpoint event |
| `POST /message?url=` | Proxies client JSON-RPC messages to the upstream message URL |
| `GET /healthz` | Health check |
| `GET /` | Service metadata |

Only the legacy SSE transport is supported. Streamable HTTP is not handled yet.

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

Deployment requires a Cloudflare account:

```bash
npx wrangler login
npm run deploy
```

For CI, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository
secrets and run the **Deploy** workflow. It is manual-only so a release is always
deliberate.

## License

MIT
