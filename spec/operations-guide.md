# Operations & Deployment Guide

> Companion to [`agent-marketplace-distribution-spec-draft.md`](./agent-marketplace-distribution-spec-draft.md)
> and [`openapi.yaml`](./openapi.yaml). The spec defines the *protocol*
> (what bytes go over the wire); this guide is prose on how an enterprise
> would actually stand one up safely. Section numbers below (§N) refer to
> the spec draft unless stated otherwise.

The spec's central design goal (§1) is that a conformant marketplace origin
can be **fully static** — no application logic, just files on disk/object
storage. This guide treats that as a hard constraint: every recommendation
below is a layer *in front of* a dumb static origin, never a change to the
origin's behavior.

## 1. TLS termination

Plain HTTP, as used in the local reference implementation (`http-marketplace/`),
is for local dev/demo only. In production:

- Terminate TLS 1.2+ at a reverse proxy, load balancer, or CDN edge in front
  of the static origin. Never expose the static origin directly on plain
  HTTP to the internet.
- Bearer tokens (§5) are credentials in plain HTTP headers — without TLS
  they are trivially sniffable, which defeats the auth model entirely.
- If using the `mtls` auth type (§4, §5), TLS termination *is* the
  authentication step: client certificate validation must happen at this
  same layer (or a layer in front of it), since a plain static origin has
  no concept of client certs at all.

## 2. Reverse proxy / auth-gateway pattern

Per §5, this spec deliberately does not invent a new auth scheme — it
expects a conventional HTTP auth layer in front of a dumb origin. Three
equivalent shapes:

1. **nginx with `auth_request`**: nginx validates the `Authorization` header
   (and/or mTLS client cert) via a subrequest to a small token-introspection
   service, then proxies to the static file root only on success. The
   static root itself never sees unauthenticated traffic and contains no
   auth logic.
2. **API gateway** (e.g. a managed API gateway product, or an ingress
   controller with a JWT/OAuth2 plugin): same shape, config-driven instead
   of nginx-config-driven.
3. **Sidecar**: an auth-proxy sidecar (e.g. oauth2-proxy-style) in the same
   pod/host as the static file server, intercepting all traffic before it
   reaches the file server's port.

In all three shapes, the response contract from §5 must be preserved by
whichever layer terminates auth:

- Missing/invalid credential → `401` with a `WWW-Authenticate` header
  (RFC 6750-style, e.g. `****** error="invalid_token"`, matching
  the reference server's behavior in `http-marketplace/server/registry-server.js`).
- Authenticated but not entitled (e.g. scope mismatch against
  `auth.scopeHint`) → `403`.

**The origin stays dumb.** None of these patterns require the static file
server to understand tokens, scopes, or users — that logic lives entirely
in the gateway/proxy/sidecar layer, exactly as §1 intends.

## 3. Caching

The manifest, per-plugin detail documents, and artifacts have different
caching needs:

| Resource | Mutability | Recommended caching |
|---|---|---|
| `marketplace.json` | Mutable — `plugins[]` summaries, `latestVersion`, `tags` change over time (§4) | Short max-age (seconds-to-minutes) or `no-cache` with `ETag`/`If-None-Match` revalidation. Clients must see new/removed plugins and updated `latestVersion` promptly. |
| `plugins/{name}.json` (per-plugin detail, §4a) | Mutable — `versions[]` grows and `yanked` flags change over time (§4a, §7), but typically changes less often than the index-wide `marketplace.json` (a single plugin's publish cadence vs. the whole catalog's) | Short max-age or `no-cache` with `ETag`/`If-None-Match`, same rationale as the manifest — clients must see yanks promptly. A moderately longer max-age than `marketplace.json` is a reasonable tradeoff if publish cadence is known to be low, but `no-cache`+revalidation is the safe default. |
| `versions[].artifact` (and `.signature`) files | Immutable — content-addressed, checksum-verified by the client (§4a, §6) | Long-lived, `Cache-Control: public, max-age=31536000, immutable`. Safe to front with a CDN, since a given URL's bytes never change (a new version gets a new URL/filename, per the reference naming convention `sample-plugin-1.0.0.tar.gz`). |

Because artifacts are immutable-by-URL and checksum-verified client-side
(§6 step 2), aggressive edge caching introduces no correctness risk even if
a CDN serves a stale cached copy indefinitely — it's the *same* bytes by
construction. The manifest and per-plugin detail documents have no such
guarantee, so treat them like any other frequently-changing API response,
not like a static asset.

## 4. Rate limiting / abuse protection

A fully static origin is still subject to volumetric abuse (scraping,
credential-stuffing against the auth gateway, or cost amplification on a
pay-per-request object store/CDN). Baseline recommendations:

- Rate-limit at the same layer that terminates auth (§2 above) — e.g.
  nginx `limit_req`, API gateway quota policies, or CDN-level rate limiting
  — keyed by token/subject where authenticated, and by IP for anonymous
  (`auth.type: "none"`) deployments.
- Apply stricter limits to repeated `401`-triggering requests (credential
  guessing) than to normal authenticated traffic.
- If using an object-store/CDN origin directly, enable the provider's
  native request-rate protections (e.g. CDN edge rate limiting) in addition
  to gateway-level limits, since a CDN cache miss still hits the origin.

This spec does not define a standard rate-limit response beyond the
existing `401`/`403` semantics (§5); a `429 Too Many Requests` is a
reasonable enterprise addition but is explicitly **not** part of the
current protocol (see §6 below on scope creep).

## 5. Structured access logging (audit)

§7 notes that because every fetch is a normal HTTP request, standard access
logs already give a free audit trail — this section makes that concrete.
Log, per request, at minimum:

- **Timestamp** (request receipt time, ISO 8601 / RFC 3339).
- **Requested path** — distinguishes a manifest fetch (`/marketplace.json`)
  from an artifact fetch (`/{artifactPath}`), and which artifact.
- **Auth subject / token identifier** — not the raw bearer token (never log
  credentials), but a stable subject ID or token ID/fingerprint the auth
  gateway resolves it to. For `mtls`, log the client certificate subject;
  for `auth.type: "none"` deployments, log source IP instead.
- **HTTP status code** — particularly `401`/`403` density per subject, a
  useful signal for compromised-credential or entitlement-misconfiguration
  investigations.
- **Response size / bytes served** — useful for detecting bulk scraping of
  an entire catalog's artifacts.

These fields map directly onto standard reverse-proxy/CDN access log
formats (nginx combined log plus a custom auth-subject field, or equivalent
CDN log fields) — no bespoke logging format is required, consistent with
the spec's "no new protocol machinery" philosophy.

## 6. Health-check / readiness endpoint (proposed addition, not in spec)

**This is a deployment-operations convention, not part of the protocol.**
The spec (§3-§6) defines exactly two resource shapes: the manifest and
artifacts. A `/healthz` (or `/readyz`) endpoint recommendation is an
operational addition layered on top for load-balancer/orchestrator health
checks — flagged here explicitly rather than silently folded into the spec
as if it were a required endpoint.

Recommendation if adopted: a plain, unauthenticated `GET /healthz` returning
`200 OK` with a minimal body (e.g. `{"status":"ok"}`), served by the same
reverse proxy/gateway layer (not the static origin, which may not want to
expose any unauthenticated route at all if `auth.type` is not `"none"`).
Do not alias this to `/marketplace.json` — a manifest fetch failure (e.g.
a transient auth-gateway outage) should not be conflated with "the server
process is up."

## 7. Serving per-plugin detail documents (two-tier manifest, v0.2)

Spec v0.2 splits the catalog into a lightweight index (`marketplace.json`,
§4) and one per-plugin detail document per plugin
(`plugins/{name}.json`, §4a). From a deployment standpoint, this is still
just **more static files** — none of §1-§6 above changes in kind, only in
degree:

- Per-plugin detail documents get the same auth-gateway treatment as the
  manifest (§2) — no special-casing needed, they're just another JSON
  resource under the same reverse proxy.
- See the caching table in §3 above: detail documents are mutable like the
  manifest (new versions/yanks), just typically at a per-plugin rather
  than whole-catalog cadence.
- Access logging (§5) should log detail-document fetches the same way as
  manifest/artifact fetches — the requested path alone already
  distinguishes "browsed the index" from "looked at plugin X's version
  history" from "downloaded plugin X's artifact," which is useful signal
  for understanding install funnels at scale (e.g. many index fetches but
  few detail-document fetches for a given plugin suggests it's browsed but
  rarely installed).
- **No new infrastructure is required.** A directory of
  `plugins/{name}.json` files sits alongside the existing
  `plugins/*.tar.gz` artifact files in the same static origin — see the
  updated layout in §9 below.

## 8. Static vs. dynamic search/browse at scale

Spec §4b documents two ways to make a large catalog browsable; this
section is the operational guidance for choosing between them.

**Option A — static-only (`capabilities.search` absent/`false`).** No new
infrastructure: the existing static origin (§1-§6) is unchanged, and
clients do their own filtering over the lightweight index they already
fetch. This is the right default for most deployments, including the
reference implementation in this repo, and keeps the "fully static
origin" story (§1's hard constraint) intact regardless of catalog size.

**Option B — static pre-sharded index files (optional convention, spec
§4b).** Still no application logic: publish additional static JSON files
(e.g. `index/by-prefix/{a..z}.json`, `index/by-tag/{tag}.json`) alongside
`marketplace.json`, each produced by a build/publish-time step (not a
runtime service) rather than served dynamically. Operationally this is
identical to §1-§6 and §7 above — just more static files with the same
caching characteristics as `marketplace.json` itself (§3): regenerate and
redeploy them whenever the catalog changes, the same way you'd update
`marketplace.json`.

**Option C — dynamic `GET /search` (`capabilities.search: true`, spec
§4b).** This is the one place in this spec's operational model that
requires actual application logic in front of (or instead of) a dumb
static origin — a process that can execute a query (even an in-memory
linear scan over the index is fine at "thousands of plugins" scale) and
return paginated JSON. Deployment implications:

- This single endpoint needs real compute, unlike every other resource in
  this spec — budget for it as a small service, not a static file route.
- Still gate it behind the same auth layer as everything else (§2) —
  `/search` should carry the same 401/403 semantics as `/marketplace.json`
  (spec §5).
- Response caching is harder than the manifest's: responses vary by
  `(q, tag, page, pageSize)`. A short-TTL cache keyed on the full query
  string (CDN or reverse-proxy level) is reasonable given spec §4b's
  pagination-style reasoning (low catalog mutation rate relative to
  request rate), but don't cache indefinitely the way artifacts are
  cached (§3) — search results are not content-addressed.
- Rate-limit `/search` at least as strictly as `/marketplace.json` (§4
  above); it's a more attractive scraping target (arbitrary queries over
  the full catalog) than a single manifest fetch.

Options A, B, and C are not mutually exclusive — a marketplace MAY publish
pre-sharded static index files (B) for cheap browsability while also
exposing `/search` (C) for more flexible querying; both still coexist with
the baseline static index + per-plugin detail flow (A) used for actual
install resolution.

## 9. Minimal reference deployment walkthrough

Mapping the above onto the existing local reference implementation
(`http-marketplace/server/registry-server.js`, which serves
`http-marketplace/registry/` and does its own inline bearer-token check —
see that file's own header comment acknowledging this is a demo
simplification):

```
Internet
  │  HTTPS (TLS terminated here)
  ▼
nginx (or equivalent reverse proxy)
  - terminates TLS (§1)
  - auth_request → token-introspection check, OR validates client cert (§2)
  - on success, proxies to registry-server.js
  - sets differentiated Cache-Control (§3, §7):
      location = /marketplace.json   { proxy_pass ...; add_header Cache-Control "no-cache"; }
      location ~ /plugins/[^/]+\.json$ { proxy_pass ...; add_header Cache-Control "no-cache"; }  # per-plugin detail docs
      location ~ \.tar\.gz$            { proxy_pass ...; add_header Cache-Control "public, max-age=31536000, immutable"; }  # artifacts
  - limit_req zone for rate limiting (§4)
  - access_log in a structured format capturing path/subject/status (§5)
  - (optional) location /healthz { return 200 '{"status":"ok"}'; }  (§6)
  - (optional, only if capabilities.search: true) location /search { ...short-TTL cache, same rate-limit zone... }  (§8)
  ▼
node http-marketplace/server/registry-server.js <port> ../registry <token>
  - plain static file server + one inline bearer check (kept for the
    self-contained demo; in this topology nginx's auth_request already
    rejects unauthenticated requests before they reach this process, so
    registry-server.js's own token check becomes a harmless second layer
    rather than the sole line of defense). As of spec v0.2 this process
    still needs no application logic of its own for the static two-tier
    structure below — see §7. (A `capabilities.search: true` deployment
    would need a separate dynamic service for `/search`, per §8 Option C —
    the reference implementation here stays static-only.)
  ▼
http-marketplace/registry/
  - marketplace.json           (mutable, lightweight index — §4)
  - plugins/{name}.json         (mutable, per-plugin detail docs — §4a, §7)
  - plugins/*.tar.gz            (immutable, checksummed artifacts)
```

This is intentionally the smallest possible production topology: the only
new component versus the local POC is the reverse proxy; `registry-server.js`
and the `registry/` directory are unchanged, consistent with the spec's
premise (§1) that the origin itself never needs to grow application logic
to go from "local demo" to "enterprise-deployable."
