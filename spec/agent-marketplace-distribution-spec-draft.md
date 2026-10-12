# Agent Plugin Marketplace Distribution Spec (Draft v0.3)

## Changelog

- **v0.3** — Scoped and retitled as the track intended for discussion with
  the [`agentplugins/agent-plugins-spec`](https://github.com/agentplugins/agent-plugins-spec)
  TSC, split out from a broader enterprise governance design (review
  workflow, entitlements, telemetry, webhooks) maintained separately and
  not part of this proposal. See the new "Relationship to other work" note
  below for why, and §5a (new) for the one piece of that split that still
  needed closing: a minimal, standard shape for "you're forbidden, here's
  how to get access" on a 403.
- **v0.2** — Two-tier manifest + optional search/browse capability,
  addressing [Open Question #2](#10-open-questions-for-review-not-yet-resolved)
  from v0.1 ("does `marketplace.json` scale to thousands of plugins?").
  Summary of changes:
  - §4 (Manifest schema): `plugins[]` entries are now **lightweight
    summaries only** (`name`, `description`, `tags`, `latestVersion`) — the
    full `versions[]` array has moved out of the manifest.
  - New §4a (Per-plugin detail document): defines a new
    `./plugins/{name}.json` document (one per plugin, fetched lazily) that
    holds the `versions[]` array previously inlined in the manifest.
  - §8 (Client algorithm): installing a plugin now requires an additional
    GET of its per-plugin detail document before a version/artifact can be
    resolved.
  - New §4b (Optional search/browse capability): documents an opt-in
    `capabilities.search` manifest field, an optional dynamic `GET /search`
    endpoint, and a static pre-sharded-index alternative for large catalogs
    that don't want to run a dynamic backend.
  - §10: Open Question #2 marked resolved; see the note in that section
    for the reasoning.
  - No breaking changes to artifact format (§6), auth (§5), or governance
    primitives (§7) — this is purely a manifest-shape and discovery-flow
    amendment.
- **v0.1** — Initial draft.

> **Status:** Local working draft. Not published anywhere. Written as a
> companion/extension proposal to [Agent Plugins 1.0](https://agent-plugins.org)
> (`agent-plugins.org`), which already standardizes plugin *content*
> (`plugin.json`, `skills/`). This document proposes a standard for plugin
> *distribution* — how a client discovers, authenticates to, fetches, and
> verifies a marketplace catalog and its plugins — without requiring git.

## Relationship to other work

This spec intentionally covers only the **client-interop** surface — the
part every harness needs to agree on, or marketplaces fragment per-vendor
the same way `marketplace.json`-over-git already has:

| Scope | Audience / purpose | Standardization target |
|---|---|---|
| **This document** | Every **client** (Copilot CLI, Claude Code, Codex, IDE extensions) needs to agree on this. Narrow by design: discovery, manifest shape, artifact fetch/verification, and the minimal 401/403/"where to get access" contract (§5, §5a). | `agentplugins/agent-plugins-spec` TSC — this is the actual proposal |
| *(not included here)* An enterprise **server's** internal governance design: review/approval workflow, entitlement CRUD, telemetry, webhooks. No other vendor's client ever calls these endpoints directly, so there's no interop cost to every enterprise building this differently — same relationship as the OCI Distribution Spec (standardized client pull/push) to a registry's own internal admin tooling (Harbor/Quay/ECR/GHCR, all different, by design). | Not a TSC ask — may be published separately as a reference design/pattern, not for ratification |

## 1. Motivation

Today, every known agent CLI that supports a plugin marketplace (GitHub
Copilot CLI, Claude Code) implements the same convention independently:

- A `marketplace.json` (or `.claude-plugin/marketplace.json`) manifest file,
  committed to a git repository.
- Plugin content stored as directories in that same repository, referenced
  by relative path (`"source": "./plugins/my-plugin"`).
- Installation performed by the client shelling out to `git clone` (or
  equivalent) against the repository URL.

This works, but ties every implementation to git as a transport:

- Git's dumb-HTTP transport cannot support shallow clones (a hard protocol
  limitation — see the companion POC in this repo, `README.md`), which
  silently breaks plain static-file hosting.
- Full git smart-HTTP (`git-http-backend`) works, but requires deploying and
  operating git-aware server infrastructure (even if thin), rather than any
  commodity static file host, CDN, or object store.
- There's no standard way to express **authentication**, **authorization
  scoping** (e.g. "this team may only see these 3 plugins"), **artifact
  integrity** (checksums/signing), or **governance** (yanking a version,
  deprecation, audit log of installs) — each client would have to invent its
  own conventions for these on top of "it's a git remote."
- Git repos encode an entire *history*, which is irrelevant to "fetch
  current version of this plugin" and adds operational overhead (push
  access control, repo hosting, garbage collection) that doesn't map
  cleanly onto typical enterprise artifact-governance tooling (which is
  usually built around package registries, not git hosting).

This spec proposes a transport that is:

- **Plain HTTP(S)** — GET requests for JSON manifests and content-addressed
  artifacts; no git binary or git protocol knowledge required on either
  side.
- **Static-file-host-friendly** — a conformant marketplace can be served
  entirely from a CDN or object store (S3, GCS, Azure Blob, or just nginx)
  with zero application logic, the same way Python's
  [PEP 503 Simple Repository API](https://peps.python.org/pep-0503/) or the
  [OCI Distribution Spec](https://github.com/opencontainers/distribution-spec)
  work.
- **Auth-transparent** — standard HTTP auth (bearer tokens, mTLS, signed
  URLs) layered in front by any reverse proxy or CDN, with no
  protocol-specific auth dance.
- **Verifiable** — every artifact is content-addressed (checksum required),
  with an optional signature field for supply-chain verification.

### Explicit non-goal

This draft does **not** claim today's real `copilot` or Claude Code CLIs
will honor this protocol out of the box — they only know git remotes today.
This is a forward-looking proposal + reference implementation, meant to be
pitched to those CLI teams (or implemented as a compatibility shim/adapter)
rather than something that works unmodified right now. (Contrast with the
git-smart-HTTP POC elsewhere in this repo, which *does* work against the
real unmodified Copilot CLI today.)

## 2. Terminology

- **Marketplace**: A catalog of plugins, identified by a base URL, exposing
  a manifest and zero or more plugin artifacts.
- **Manifest**: The top-level `marketplace.json` document describing the
  marketplace and listing its plugins.
- **Plugin artifact**: An immutable, content-addressed archive (tarball)
  containing one version of one plugin's full content (an Agent Plugins 1.0
  `plugin.json` plus its `skills/`, etc.).
- **Client**: Software (an agent CLI, IDE extension, or install script) that
  resolves a marketplace URL into installed plugin content.

## 3. Discovery

A marketplace is identified by a single base URL, e.g.:

```
https://plugins.acme.com/marketplace/
```

The client fetches the manifest at:

```
GET {base_url}/marketplace.json
```

Response: `Content-Type: application/json`, body conforming to §4.

Client implementations MUST follow HTTP redirects (301/302/307/308) and
MUST treat any non-2xx response as discovery failure.

## 4. Manifest schema (`marketplace.json`)

**As of v0.2, this is a lightweight index.** Each `plugins[]` entry is a
*summary only* — enough to browse, search, and decide whether to look at a
plugin further — and does **not** contain the full version history or
artifact references. That content now lives in a separate per-plugin
detail document (§4a), fetched lazily, so that `marketplace.json`'s size is
bounded by catalog *count*, not by catalog count × average version-history
length. See §10 (resolved) for the motivating scale discussion.

```jsonc
{
  "specVersion": "1.0",
  "name": "acme-plugins",
  "owner": {
    "name": "Example Corp",
    "email": "plugins@acme.com",
    "url": "https://acme.com"
  },
  "metadata": {
    "description": "Example Corp's internal plugin catalog",
    "version": "3.2.0",
    "updatedAt": "2026-10-10T12:00:00Z"
  },
  "auth": {
    "type": "bearer",            // "none" | "bearer" | "mtls"
    "tokenUrl": null,             // optional: where to obtain a token (e.g. an OIDC device-code flow)
    "scopeHint": "acme-plugins:read"
  },
  "capabilities": {
    "search": false               // see §4b — true if GET /search is exposed
  },
  "plugins": [
    {
      "name": "sample-plugin",
      "description": "Minimal sample plugin.",
      "tags": ["productivity", "demo"],
      "latestVersion": "1.0.0"
    }
  ]
}
```

Notes:

- `source` (the git-relative-path field used by today's clients) is
  **replaced** by content-addressed, checksummed artifact references —
  now found in the per-plugin detail document (§4a) rather than inline
  here. This is the core change that removes the git dependency: instead
  of "clone this directory out of a repo," the client downloads one
  immutable file and verifies its hash.
- **`versions[]`/`artifact` are no longer part of a `plugins[]` entry** (as
  of v0.2 — see Changelog). A client that needs version/artifact
  information for a specific plugin must fetch that plugin's detail
  document (§4a).
- `tags` is new in v0.2: an array of free-form strings, intended to support
  both client-side local filtering (static-only marketplaces, §4b) and
  server-side `?tag=` filtering (dynamic search, §4b).
- `capabilities.search` is new in v0.2 (§4b): `false` or absent means this
  marketplace is static-only (no search endpoint); `true` means `GET
  /search` is available.
- `auth.type` lets a marketplace declare what kind of credential a client
  should present; the actual credential acquisition (login flow) is out of
  scope for this spec (same as how `npm`/`pip`/`docker` each have their own
  login UX, but a consistent `WWW-Authenticate`-style challenge on 401).

## 4a. Per-plugin detail document

Each plugin's full version history and artifact references live in their
own document, fetched lazily by name:

```
GET {base}/plugins/{name}.json
```

resolved **relative to the manifest URL**, the same way artifact URLs are
resolved (§4, §6) — so a marketplace can be mirrored/rehosted without
rewriting every reference, and the URL pattern is just a convention, not a
hardcoded absolute path.

```jsonc
// GET {base}/plugins/sample-plugin.json
{
  "name": "sample-plugin",
  "versions": [
    {
      "version": "1.0.0",
      "artifact": {
        "url": "./sample-plugin-1.0.0.tar.gz",
        "mediaType": "application/gzip",
        "sizeBytes": 2048,
        "sha256": "b7b7...<64 hex chars>...",
        "signature": {
          "type": "sigstore-bundle",
          "url": "./sample-plugin-1.0.0.tar.gz.sigstore.json"
        }
      },
      "publishedAt": "2026-10-10T12:00:00Z",
      "yanked": false,
      "yankedReason": null
    }
  ]
}
```

Notes:

- This is exactly the content that, under v0.1, lived inline in the
  manifest's `plugins[].versions[]` — moved to its own file, not
  redesigned. `versions[]` still makes version history and rollback
  explicit and queryable without needing git log, and `yanked`/
  `yankedReason` still gives a standard governance primitive for pulling a
  version (§7) — none of that semantics changes in v0.2.
- Within a detail document, `artifact.url` (and `.signature.url`) are
  resolved **relative to the per-plugin detail document's own URL**, not
  the manifest's URL (since that's the document the client just fetched it
  from) — in the common case where both documents live under the same
  `plugins/` convention this is usually the same directory and the
  distinction rarely matters, but implementers should not assume the
  detail document and the manifest share a base path.
- `404` on this endpoint means "no such plugin" (e.g. a stale/incorrect
  name) and should be treated like any other missing-resource response
  (§5, §6's artifact-fetch error handling applies analogously).
- A marketplace with a very large catalog gets most of its scaling benefit
  here: clients only ever fetch the detail document for plugins they
  actually intend to install or inspect closely, never the full version
  history of every plugin in the catalog.

## 4b. Optional search/browse capability

The lightweight index (§4) and per-plugin detail documents (§4a) are
together sufficient for a **fully static, zero-server-logic** marketplace
of any size — exactly the deployment model this spec is built around (§1).
`capabilities.search` on the manifest lets a marketplace additionally offer
dynamic server-side browse/search on top of that baseline, as a clearly
separated, optional tier:

- **`capabilities.search` absent or `false` (baseline, default):** the
  marketplace is static-file-hostable with zero application logic, exactly
  like the rest of this spec. There is no search endpoint. Search/filter is
  entirely the **client's responsibility**: download the lightweight index
  (§4) once, then filter/search locally over its summary fields —
  including the new `tags` field — the same way a client might locally
  filter any small-to-medium JSON array. This remains practical well past
  "thousands of plugins," since each index entry is only a handful of
  short strings.
- **`capabilities.search: true` (optional dynamic tier):** the marketplace
  additionally exposes:

  ```
  GET {base}/search?q=&tag=&page=&pageSize=
  ```

  returning a paginated subset of the same lightweight summary objects
  used in the index (§4), plus pagination metadata:

  ```jsonc
  {
    "page": 1,
    "pageSize": 50,
    "totalCount": 4213,
    "plugins": [
      { "name": "sample-plugin", "description": "...", "tags": ["productivity"], "latestVersion": "1.0.0" }
    ]
  }
  ```

  All query parameters are optional: `q` is a free-text match against name
  and description, `tag` filters to plugins carrying that tag (repeatable
  for AND-of-tags, server's choice to document), `page`/`pageSize` control
  offset-based pagination. **Pagination style:** this spec picks
  simple `page`/`pageSize`/`totalCount` (offset pagination) over a cursor,
  because (a) it's trivially cacheable per `(q, tag, page, pageSize)` tuple
  at a CDN/reverse-proxy layer the same way the rest of this spec favors
  plain-HTTP-cacheable shapes (§3 caching concerns), (b) catalog mutation
  rate is low relative to request rate for a plugin marketplace (unlike,
  say, a live event feed), so offset drift from concurrent inserts is an
  acceptable tradeoff, and (c) it keeps the response shape trivially
  implementable by the same static-friendly tooling this spec otherwise
  favors (a server can compute it from an in-memory or on-disk sorted
  array with no stateful cursor store). A future revision MAY add
  cursor-based pagination as an alternative if large, highly-volatile
  catalogs make offset drift a real problem in practice.

  A `capabilities.search: true` marketplace is **not required** to stop
  exposing the static index/detail documents — `/search` is additive. A
  client MAY use `/search` for interactive browse/search UX and still use
  the static index + per-plugin detail flow (§4, §4a, §8) for the actual
  install resolution step, since `/search` results reuse the same summary
  shape and the install flow is unchanged either way.

- **Static, no-server-logic alternative for large catalogs (optional
  convention):** an implementer who wants some server-assisted
  browsability for a large catalog, without running any dynamic backend,
  MAY additionally publish **pre-sharded/faceted static index files** —
  for example `./index/by-prefix/{a..z}.json` (plugins whose name starts
  with that letter) or `./index/by-tag/{tag}.json` (plugins carrying that
  tag), each just another lightweight-index-shaped (§4) static JSON file.
  This is the same idea as
  [PEP 503](https://peps.python.org/pep-0503/)'s per-package static pages:
  it trades "one request returns everything" for "requests are bucketed
  into many small static files," so a CDN/object-store origin can serve a
  browsable catalog of any size without ever running search logic. This
  convention is intentionally unstandardized beyond "it's optional, and
  when present it's just more lightweight-index-shaped static JSON" — exact
  sharding scheme is a marketplace-operator choice, not a protocol
  requirement.

## 5. Authentication

> **Note:** sections 5 and 5a describe the fuller auth surface this
> protocol could standardize. The first-round TSC proposal (see the
> linked Discussion in the repo README) intentionally does **not** ask
> for 401/403 handling or `request_access_url` to be standardized yet —
> it treats auth as ordinary, already-solved HTTP/operator policy. These
> sections are kept here as the exploratory "fuller" version for a
> possible later round, not part of the current ask.

All requests (manifest and artifact fetches) MAY require authentication.
Server behavior:

- Unauthenticated/invalid request → `401 Unauthorized` with a standard
  `WWW-Authenticate` header (`Bearer realm="...", error="invalid_token"`
  etc., per RFC 6750) so generic HTTP clients get a comprehensible error
  without spec-specific parsing.
- Authenticated-but-forbidden (e.g. plugin not in the caller's entitlement
  scope) → `403 Forbidden`.
- This spec intentionally does not invent a new auth scheme: bearer tokens
  (RFC 6750), mTLS, or signed URLs (e.g. S3 pre-signed URLs / CloudFront
  signed cookies) are all valid, because they're all just standard HTTP —
  the entire point of moving off git is that any enterprise auth stack
  already knows how to gate plain HTTP.

## 5a. Requesting access on 403

A bare `403 Forbidden` tells a client *that* it's forbidden, not what to do
about it. Different marketplaces handle entitlement/access management
completely differently server-side (that's intentionally
implementation-defined — see the relationship table above), so this spec
does not standardize *how* access is granted, only a minimal, optional
**pointer** a server can include so a client can surface something
actionable instead of a dead end:

```
403 Forbidden
Content-Type: application/json

{
  "error": "forbidden",
  "message": "Not entitled to sample-plugin",
  "request_access_url": "https://plugins.acme.com/request-access?plugin=sample-plugin"
}
```

- `request_access_url` is OPTIONAL. A client MUST treat its absence as "no
  self-service path exists; contact your administrator" and MUST NOT
  assume any particular shape or protocol for what that URL leads to (it
  could be a web form, a ticketing system deep link, or an API call in a
  server that implements its own entitlement model). The client's only standardized obligation is: if present,
  surface it to the user (e.g. "run `copilot plugin marketplace
  request-access sample-plugin`" or just print the URL); if absent, print
  a generic "access denied, contact your administrator" message.
- This keeps the *client* contract to one optional JSON field, while
  leaving 100% of the actual grant/approval workflow as enterprise-specific
  (exactly the governance-API territory this spec deliberately excludes).

## 6. Artifact format

A plugin artifact is a gzipped tar archive (`.tar.gz`) whose root directly
contains the Agent Plugins 1.0 plugin content:

```
sample-plugin-1.0.0.tar.gz
└── plugin.json
└── skills/
    └── greet/
        └── SKILL.md
```

(No enclosing marketplace/repo directory — the archive root is the plugin
root, so clients can extract-and-use without path rewriting.)

Clients MUST:
1. Download the artifact.
2. Compute its SHA-256 and compare against `artifact.sha256`; abort on
   mismatch.
3. (Optional, recommended) Verify `artifact.signature` if present.
4. Extract into the local plugin store.

## 7. Governance primitives

- **Versioning**: semver strongly recommended for `version` fields.
- **Yanking**: `yanked: true` on a version signals clients should not
  newly-install it (but may continue using an already-installed copy,
  analogous to npm's `deprecate`/unpublish semantics).
- **Audit**: out of scope for the manifest format itself, but because every
  fetch is a normal HTTP request, standard access logs / CDN logs / reverse
  proxy logs already give an audit trail for free — another advantage over
  git (where "who cloned this" is not something a bare repo on a plain
  static host can tell you at all).
- **Scoping**: `auth.scopeHint` plus server-side 403s let a marketplace
  serve different catalogs/entitlements per credential, without needing
  separate marketplace URLs per team.

## 8. Client algorithm (reference)

```
1. GET {base}/marketplace.json  (with credential if configured)
   -> 401/403: surface auth error to user
   -> 2xx: parse manifest
2. To install plugin P (optionally @version V):
   a. Look up P in manifest.plugins[] (lightweight summary — §4); if not
      found, fail with "plugin not found"
   b. GET {base}/plugins/{P}.json (resolved relative to the manifest URL,
      per §4a) -> 404: fail with "plugin not found"; 2xx: parse detail doc
   c. In the detail doc's versions[], pick V or latestVersion (from the
      summary in step a)
   d. If version.yanked: warn, require --force or explicit version pin
   e. GET version.artifact.url (resolved relative to the detail document's
      URL, per §4a)
   f. Verify sha256 (and signature, if present/required by policy)
   g. Extract to <plugin-store>/<marketplace-name>/<plugin-name>/<version>/
   h. Record install metadata (name, version, marketplace, sha256) in local
      plugin registry
3. To update: re-fetch manifest, compare latestVersion, repeat step 2 if
   newer / not yanked.
```

(v0.2 change: step 2 now has an extra per-plugin detail fetch — step b —
between finding the plugin in the index and resolving its version/artifact,
since that data no longer lives inline in the manifest. See Changelog and
§4a.)

## 9. Compatibility / migration path

- A marketplace MAY serve **both** this spec's `marketplace.json` and a
  legacy git-based `marketplace.json` (with `source` paths) from the same
  git repository, for clients that only understand git remotes today — a
  git-hosted legacy manifest and a plain-HTTP manifest under this spec can
  coexist as an example of exactly that dual-publishing approach.
- A future client could support both `source` (git-relative-path) and
  `versions[].artifact` (content-addressed URL) fields in the same schema,
  treating this spec as additive rather than a breaking replacement — this
  draft keeps the two in separate example files for clarity, but adoption
  likely wants them merged into a single evolved schema.

## 10. Open questions (for review, not yet resolved)

- Should the manifest itself be versioned/signed as a whole (not just
  per-artifact), to prevent a MITM from serving a stale/rolled-back
  manifest? (Compare: TUF — The Update Framework.)
- ~~Should there be a standard "search/index" endpoint for marketplaces
  with very large catalogs (pagination), rather than one monolithic
  `marketplace.json`?~~ **Resolved in v0.2** (see Changelog): the manifest
  is now a lightweight index (§4) with full version data split into
  per-plugin detail documents (§4a), which bounds `marketplace.json` size
  by plugin *count* rather than count × version-history length regardless
  of catalog size. On top of that static baseline, §4b documents an
  *optional* `capabilities.search`-gated dynamic `GET /search` endpoint
  with `page`/`pageSize`/`totalCount` pagination, plus a static
  pre-sharded-index convention as a no-server-logic alternative for
  operators who want some server-assisted browsability without running a
  dynamic backend. The baseline (non-`capabilities.search`) story remains
  fully static-file-hostable, consistent with §1's core motivation.
- Naming collision: should marketplace `name` be globally unique (like npm
  package names), or always namespaced by owner/URL to avoid local registry
  key collisions (this repo's earlier naming-confusion incident is a small
  real-world example of why this matters)?
- Should there be a standard "capabilities" field so a client can tell
  before downloading whether a plugin needs permissions it doesn't support
  (MCP servers, LSP servers, hooks, etc.)?
