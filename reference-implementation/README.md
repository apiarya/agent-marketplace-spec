# Reference implementation

A minimal, working client + server proving the protocol in
[`../spec/agent-marketplace-distribution-spec-draft.md`](../spec/agent-marketplace-distribution-spec-draft.md)
is actually implementable end-to-end: manifest fetch → per-plugin detail
fetch → bearer-token auth → artifact download → SHA-256 verify → extract.
No git anywhere in the path.

This is intentionally the simplest possible implementation of each piece
— not production-hardened, just enough to prove the shape of the protocol
works. There's no attempt here to standardize 401/403/entitlement
handling (see the note in spec §5); the client just does the ordinary
thing with whatever status code it gets back.

## Layout

| Path | What it is |
|---|---|
| `server/registry-server.js` | Plain static-file HTTP server + one bearer-token auth check. Stands in for "any static host / CDN with an auth rule in front of it." |
| `client/install.js` | Stand-in for what a real agent CLI's plugin installer would do: fetch manifest → resolve version → download artifact → verify checksum → extract. |
| `registry/` | A sample marketplace: `marketplace.json` (index), `plugins/sample-plugin.json` (per-plugin detail), and a tiny `sample-plugin-1.0.0.tar.gz` artifact. |

## Try it

Requires Node.js (no dependencies — uses only Node's built-in `http`/`https`/`crypto`).

```bash
# 1. Start the reference server (defaults: port 8090, acme-plugins:read token "demo-token-123")
node server/registry-server.js

# 2. In another terminal, install the sample plugin through the reference client
node client/install.js http://localhost:8090 sample-plugin demo-token-123 /tmp/plugin-store

# 3. Inspect what got installed
cat /tmp/plugin-store/installed.json
```

To try it with auth disabled entirely (`auth.type: "none"` in the manifest):

```bash
node server/registry-server.js 8090 ../registry ""
node client/install.js http://localhost:8090 sample-plugin "" /tmp/plugin-store
```

This is the same reference implementation referenced in the TSC
Discussion post as having been "built and validated" — see the repo
[README](../README.md) for the Discussion link.
