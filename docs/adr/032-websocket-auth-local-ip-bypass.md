---
tags: [decision, coordinator, websocket, auth, tailscale]
related: [concepts/coordinator-web-auth.md, modules/drone-coordinator.md, meta/web-ui-tailscale-detection-research.md]
---

# 032: WebSocket Auth Local-IP Bypass

**Status**: Implemented (2026-07-01)

## Context

The coordinator runs two Fastify servers sharing the same `setupServer()` function, which registers a `/ws` WebSocket endpoint. Both servers use an `onRequest` auth hook (from `web-auth.ts`) that checks the `Authorization` header for non-local requests, treating Tailscale CGNAT IPs (100.64.0.0/10) as local.

However, the WebSocket handler inside the `/ws` route had its own independent token check that did **not** mirror the `onRequest` hook's local-IP bypass. Since the browser `WebSocket` API cannot set custom HTTP headers, the token must come via a query parameter (`?token=...`). The flow was:

1. Browser connects via Tailscale → IP is in CGNAT range
2. `onRequest` hook sees Tailscale IP → considers it local → **passes** → WebSocket upgrade succeeds (`101 Switching Protocols`)
3. WebSocket handler runs its own token check — does NOT check IP, only the token
4. If a token is configured and the browser didn't include it (or it's wrong) → `socket.close(4001, 'Unauthorized')`
5. Client's `onclose` triggers retry loop with exponential backoff

## Decision

Reuse the existing `isLocalRequest()` function from `web-auth.ts` in the WebSocket handler to skip token validation for local/Tailscale connections, consistent with the `onRequest` hook.

## Changes

Three changes across two files:

1. **`drone-coordinator/src/web-auth.ts`** — Exported `isLocalRequest` (added `export` keyword)
2. **`drone-coordinator/src/index.ts`** — Imported `isLocalRequest` from `./web-auth.js`
3. **`drone-coordinator/src/index.ts`** — Wrapped the WebSocket token check in `if (!isLocalRequest(req))`

## Consequences

- **Positive**: Tailscale-connected clients can now connect to the WebSocket without providing a token, consistent with the `onRequest` hook's behavior
- **Positive**: Non-local, non-Tailscale connections still require a valid token — security is preserved
- **Positive**: The fix is minimal (3 lines of logic change) and reuses existing infrastructure
- **Neutral**: The `isLocalRequest` function is now part of the public module API

## Related

- [[concepts/coordinator-web-auth]] — Web auth concept (updated with WebSocket auth details)
- [[modules/drone-coordinator]] — Coordinator module (updated WebSocket section)
- [[meta/web-ui-tailscale-detection-research]] — Research note on tailscale detection
