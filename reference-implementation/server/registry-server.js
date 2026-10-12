#!/usr/bin/env node
/**
 * Reference server for the git-free HTTP marketplace distribution spec
 * (see spec/agent-marketplace-distribution-spec-draft.md).
 *
 * This is intentionally the simplest possible implementation: a plain
 * static file server (like server/static-server.js in the git-based POC)
 * plus one layer of standard bearer-token auth. There is zero git logic,
 * zero protocol-specific auth — just files on disk and an
 * Authorization header check, exactly as the spec requires. In production
 * this auth layer would typically be a reverse proxy / CDN edge rule
 * instead of inline code, but it's inlined here for a self-contained demo.
 *
 * Usage: node http-marketplace/server/registry-server.js [port] [root-dir] [token]
 *   Defaults: port=8090, root-dir=../registry, token=demo-token-123
 *
 * Set token to the empty string ("") to disable auth entirely (auth.type
 * "none" in the manifest).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2]) || 8090;
const ROOT = path.resolve(__dirname, process.argv[3] || "../registry");
const TOKEN = process.argv[4] !== undefined ? process.argv[4] : "demo-token-123";

const MIME = {
  ".json": "application/json",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
};

function unauthorized(res) {
  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": 'Bearer realm="acme-plugins", error="invalid_token"',
  });
  res.end(JSON.stringify({ error: "invalid_token", message: "Missing or invalid bearer token" }));
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}

const server = http.createServer((req, res) => {
  if (TOKEN) {
    const header = req.headers["authorization"] || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match || match[1] !== TOKEN) {
      return unauthorized(res);
    }
  }

  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const safePath = path.normalize(path.join(ROOT, urlPath));
  if (!safePath.startsWith(ROOT)) return notFound(res);

  fs.stat(safePath, (err, stats) => {
    if (err || stats.isDirectory()) return notFound(res);
    const ext = path.extname(safePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(safePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Git-free HTTP marketplace reference server at http://localhost:${PORT}/`);
  console.log(`Serving: ${ROOT}`);
  console.log(`Auth: ${TOKEN ? `Bearer token required ("${TOKEN}")` : "disabled"}`);
  console.log(`Manifest: http://localhost:${PORT}/marketplace.json`);
});
