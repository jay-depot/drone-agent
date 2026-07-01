---
key: coordinator-web-ui-http-port-plan
tags:
  - coordinator
  - web-ui
  - http
  - auth
  - plan
created: 2026-06-30T23:12:06.485Z
updated: 2026-06-30T23:12:06.485Z
---

# Coordinator Web UI HTTP Port Plan

## Summary

Add a second, unencrypted HTTP port to the coordinator (default 8080, default host 127.0.0.1) that serves everything the primary port does (API, WebSocket, static UI, SPA fallback). An auth token (auto-generated 32-char hex, stored in SQLite) is required for non-local connections. Local connections (127.0.0.1, ::1, machine's own LAN IPs, tailscale 100.64.0.0/10) bypass auth.

## Implementation Steps

### Step 1: Add web token to SQLite database

**Agent:** coder
**File:** `drone-coordinator/src/db.ts`

- Add `web_token` table: `CREATE TABLE IF NOT EXISTS web_token (id INTEGER PRIMARY KEY, token TEXT NOT NULL, created_at INTEGER NOT NULL)`
- Add functions: `getWebToken()`, `generateWebToken()`, `initWebToken()` (auto-generates on first startup)

### Step 2: Add CLI flags and commands

**Agent:** coder
**File:** `drone-coordinator/src/index.ts`

- Add to Config: `webPort: number` (default 8080), `webHost: string` (default '127.0.0.1')
- Add commands: `--show-web-token`, `--generate-web-token`
- Add CLI args: `--web-port`, `--web-host`
- Add handler functions and update help text

### Step 3: Extract shared server setup into a factory function

**Agent:** coder
**File:** `drone-coordinator/src/index.ts` (refactor)

Extract route registration, WebSocket setup, static file serving, and SPA fallback into a reusable `setupServer(app, uiDistPath)` function.

### Step 4: Create auth middleware for the web port

**Agent:** coder
**New file:** `drone-coordinator/src/web-auth.ts`

- `isLocalRequest(req)`: checks 127.0.0.1, ::1, machine's own LAN IPs, tailscale 100.64.0.0/10
- `createWebAuthMiddleware(getToken)`: Fastify onRequest hook, applies to /api/\* and /ws, returns 401 for non-local requests without valid Bearer token

### Step 5: Create second Fastify instance for web port

**Agent:** coder
**File:** `drone-coordinator/src/index.ts`

Create `webApp` (HTTP only, no TLS), register auth middleware, call `setupServer(webApp, uiDistPath)`, listen on `config.webPort` / `config.webHost`.

### Step 6: Update SPA with login page and token management

**Agent:** coder
**Files:** `drone-coordinator-ui/src/`

- New: `src/hooks/use-auth.ts` — localStorage token management
- New: `src/pages/login.tsx` — token entry form
- Update: `src/App.tsx` — auth check, redirect to /login on 401
- Update: `src/hooks/use-websocket.ts` — include token as query param

### Step 7: Update WebSocket endpoint to accept token via query parameter

**Agent:** coder
**File:** `drone-coordinator/src/index.ts`

Extract token from WebSocket upgrade request query string, validate for non-local connections.

### Step 8: Update help text

**Agent:** coder
**File:** `drone-coordinator/src/index.ts`

### Step 9: Verify the build

**Agent:** tester

### Step 10: Check the work against validation criteria

**Agent:** reviewer

## Validation Criteria

- [ ] `pnpm build` succeeds across all packages
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] Coordinator starts and listens on both ports (3456 and 8080 by default)
- [ ] `drone-coordinator --show-web-token` prints the token
- [ ] `drone-coordinator --generate-web-token` generates a new token
- [ ] Web UI is accessible at `http://127.0.0.1:8080/` without auth
- [ ] API calls from `127.0.0.1:8080` succeed without auth
- [ ] API calls from a non-local IP to port 8080 return 401 without token
- [ ] API calls from a non-local IP to port 8080 succeed with valid `Authorization: Bearer <token>` header
- [ ] SPA login page appears when API returns 401
- [ ] Entering valid token on login page stores it and allows access
- [ ] Token persists across page reloads (localStorage)
- [ ] WebSocket on web port works for local connections
- [ ] Primary port (3456) behavior is unchanged
- [ ] Tailscale IPs (100.64.0.0/10) bypass auth on web port

## Notes

- Tailscale detection currently uses only IP range check (100.64.0.0/10). See project memory `web-ui-tailscale-detection-research` for future improvements.
- The auth middleware only applies to `/api/*` and `/ws` routes — static files and the SPA index.html are always served without auth so the login page can load.
- WebSocket auth uses query parameter (`?token=...`) since custom headers are difficult during WebSocket upgrade.
