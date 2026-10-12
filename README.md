# agent-marketplace-spec

A proposed, **git-free, plain-HTTP protocol** for distributing AI agent
plugin marketplaces — so any client ("harness": Copilot CLI, Claude Code,
or others) can discover, verify, and fetch plugins from any conformant
marketplace, without requiring `git clone` as the transport.

> **Status: draft / pre-proposal.** This is a preliminary v1-style spec,
> intentionally kept small, written to get a scope/direction read from
> the [`agentplugins/agent-plugins-spec`](https://github.com/agentplugins/agent-plugins-spec)
> TSC before investing further. Nothing here is final or adopted by any
> harness yet.

## Why

Today, every harness that supports a plugin marketplace has independently
converged on the same convention: commit a `marketplace.json` to a git
repo, and have the client `git clone` it. This works, but:

- Ties every implementation to git as a transport, even though a plugin
  catalog is conceptually closer to a package registry (npm, PEP 503)
  than to a source repo.
- Has a concrete, reproducible failure mode: git's dumb-HTTP transport
  cannot do a shallow clone, which silently breaks the simplest possible
  self-hosted setup — a marketplace served from plain static files, S3,
  or a CDN.
- Has no standard way to express "you're authenticated but not entitled
  to this plugin," which matters for private/enterprise-controlled
  catalogs.

See [`spec/agent-marketplace-distribution-spec-draft.md`](spec/agent-marketplace-distribution-spec-draft.md)
for the full draft protocol.

## What's in this repo

| File | What it is |
|---|---|
| [`spec/agent-marketplace-distribution-spec-draft.md`](spec/agent-marketplace-distribution-spec-draft.md) | The protocol itself: discovery, manifest schema, artifact format, auth, client algorithm, open questions. |
| [`spec/openapi.yaml`](spec/openapi.yaml) | Formal OpenAPI 3.1 companion schema for the manifest/artifact endpoints defined in the spec. |
| [`spec/operations-guide.md`](spec/operations-guide.md) | Prose guidance on how an enterprise would actually stand up a conformant marketplace origin (TLS, CDN, auth) safely. |

**Deliberately not in this repo yet:** review/approval workflows,
entitlement management, telemetry, and webhook/event notifications. Those
are enterprise-governance concerns — no other harness's client ever calls
those endpoints, so they don't need cross-vendor standardization the way
the distribution protocol above does. They may surface in a later,
separate proposal once there's signal on the core protocol.

## Status / discussion

This spec is being proposed for discussion with the Agent Plugins TSC.
Track the discussion thread here once posted: *(link to be added)*.

## License

TBD — intended to be a freely implementable open spec (likely
CC-BY or similar); not yet finalized.
