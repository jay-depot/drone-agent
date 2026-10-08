---
tags: [decision, architecture, coordinator, web-ui, auth]
related:
  [
    021-coordinator-web-ui.md,
    modules/drone-coordinator.md,
    modules/drone-coordinator-ui.md,
    concepts/coordinator-web-auth.md,
  ]
---

# 025: Coordinator Web UI HTTP Port

**Summary**: Add a second, unencrypted HTTP port to the coordinator for browser access, with an auth token for non-local connections.

## Context

The coordinator serves everything (API, WebSocket, static UI) on a single port (3456) with optional self-signed TLS. Browsers reject self-signed certs, making the web UI painful to use. The previous approach of serving the UI over the same TLS port was not browser-friendly.

## Decision

Add a second, unencrypted HTTP port (default 8080, default host `127.0.0.1`) that mirrors everything the primary port serves. An auto-generated 32-char hex auth token protects non-local access.

### Dual-Port Architecture

The coordinator now creates two Fastify instances:

1. **Primary server** (port 3456) — with TLS if configured, no auth middleware. Used by beacons and agents for API communication.
2. **Web server** (port 8080, `127.0.0.1`) — HTTP only, no TLS, with auth middleware. Used by browsers for the web UI.

Both servers share the same `setupServer()` factory function that registers all routes, WebSocket, static files, and SPA fallback.

### Auth Token

- **Auto-generated** on first startup (32-char hex via `crypto.randomBytes(16).toString('hex')`)
- **Stored** in SQLite `web_token` table
- **CLI commands**: `--show-web-token` (print current token), `--generate-web-token` (generate new one)
- **Sent** via `Authorization: Bearer <token>` header for REST, `?token=` query parameter for WebSocket

### Local Connection Bypass

Auth is bypassed for connections from:

- Loopback addresses (`127.0.0.1`, `::1`)
- The machine's own network interfaces
- Tailscale CGNAT range (`100.64.0.0/10`)

### Auth Middleware Scope

The auth middleware only applies to API routes and `/ws`. Static files (`/assets/*`) and the SPA index (`/`) are always served without auth so the login page can load.

### SPA Auth Flow

1. User opens `http://127.0.0.1:8080/` — SPA loads, tries to fetch data
2. If API returns 401, SPA shows a login page
3. User enters the token (obtained via `drone-coordinator --show-web-token`)
4. Token is stored in `localStorage` and included in all subsequent requests
5. WebSocket connection includes token as `?token=` query parameter

## Consequences

- **Positive**: Browsers can access the UI without TLS certificate warnings
- **Positive**: The primary API port remains unchanged for beacon/agent communication
- **Positive**: Local development is frictionless (no auth on localhost)
- **Positive**: Tailscale users get seamless access (CGNAT range bypass)
- **Positive**: Token persists across page reloads (localStorage)
- **Negative**: The SPA JavaScript bundle is publicly accessible on the web port (no secrets in the bundle, so this is acceptable)
- **Negative**: Tailscale detection currently uses only IP range check — may need refinement later (see web-ui-tailscale-detection-research)

## Related

- [021-coordinator-web-ui](021-coordinator-web-ui.md) — Original Web UI decision
- [drone-coordinator](../../drone-coordinator/) — Coordinator module
- [drone-coordinator-ui](../../drone-coordinator-ui/) — Web UI module
- coordinator-web-auth — Web auth concept
