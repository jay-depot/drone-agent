---
key: coordinator-web-ui-http-port-plan
tags:
  - coordinator
  - web-ui
  - http
  - auth
  - plan
created: 2026-06-30T23:12:06.485Z
updated: 2026-07-01T00:05:47.442Z
---

# Coordinator Web UI HTTP Port Plan

## Summary

Add a second, unencrypted HTTP port to the coordinator (default 8080, default host 127.0.0.1) that serves everything the primary port does (API, WebSocket, static UI, SPA fallback). An auth token (auto-generated 32-char hex, stored in SQLite) is required for non-local connections. Local connections (127.0.0.1, ::1, machine's own LAN IPs, tailscale 100.64.0.0/10) bypass auth.

## Implementation Steps

### Step 1: Add web token to SQLite database ✅

**Agent:** coder
**File:** `drone-coordinator/src/db.ts`

- Added `web_token` table: `CREATE TABLE IF NOT EXISTS web_token (id INTEGER PRIMARY KEY, token TEXT NOT NULL, created_at INTEGER NOT NULL)`
- Added functions: `getWebToken()`, `generateWebToken()`, `initWebToken()` (auto-generates on first startup)

### Step 2: Add CLI flags and commands ✅

**Agent:** coder
**File:** `drone-coordinator/src/index.ts`

- Added to Config: `webPort: number` (default 8080), `webHost: string` (default '127.0.0.1')
- Added commands: `--show-web-token`, `--generate-web-token`
- Added CLI args: `--web-port`, `--web-host`
- Added handler functions and updated help text

### Step 3: Extract shared server setup into a factory function ✅

**Agent:** coder
**File:** `drone-coordinator/src/index.ts` (refactor)

Extracted route registration, WebSocket setup, static file serving, and SPA fallback into a reusable `setupServer(app, uiDistPath, opts?)` function.

### Step 4: Create auth middleware for the web port ✅

**Agent:** coder
**New file:** `drone-coordinator/src/web-auth.ts`

- `isLocalRequest(req)`: checks 127.0.0.1, ::1, machine's own LAN IPs, tailscale 100.64.0.0/10
- `createWebAuthMiddleware(getToken)`: Fastify onRequest hook, applies to all API routes and /ws, returns 401 for non-local requests without valid Bearer token

### Step 5: Create second Fastify instance for web port ✅

**Agent:** coder
**File:** `drone-coordinator/src/index.ts`

Created `webApp` (HTTP only, no TLS), registered auth middleware, called `setupServer(webApp, uiDistPath, { getToken })`, listens on `config.webPort` / `config.webHost`.

### Step 6: Update SPA with login page and token management ✅

**Agent:** coder
**Files:** `drone-coordinator-ui/src/`

- New: `src/hooks/use-auth.tsx` — localStorage token management, `useAuthenticatedFetch` hook
- New: `src/pages/login.tsx` — token entry form
- Update: `src/App.tsx` — AuthProvider wrapper, login page on 401
- Update: `src/hooks/use-websocket.tsx` — include token as query param
- Update: All pages use `useAuthenticatedFetch` instead of raw `fetch`

### Step 7: Update WebSocket endpoint to accept token via query parameter ✅

**Agent:** coder
**File:** `drone-coordinator/src/index.ts`

WebSocket handler checks token from query string for non-local connections.

### Step 8: Update help text ✅

**Agent:** coder
**File:** `drone-coordinator/src/index.ts`

### Step 9: Verify the build ✅

**Agent:** tester

- `pnpm build` — all 5 packages compile successfully
- `pnpm typecheck` — passes across all packages
- `pnpm lint` — passes (ESLint + Prettier)

### Step 10: Check the work against validation criteria ✅

**Agent:** reviewer

- [x] `pnpm build` succeeds across all packages
- [x] `pnpm typecheck` passes
- [x] `pnpm lint` passes
- [x] Coordinator starts and listens on both ports (3456 and 8080 by default)
- [x] `drone-coordinator --show-web-token` prints the token
- [x] `drone-coordinator --generate-web-token` generates a new token
- [x] Web UI is accessible at `http://127.0.0.1:8080/` without auth
- [x] API calls from `127.0.0.1:8080` succeed without auth
- [x] API calls from a non-local IP to port 8080 return 401 without token
- [x] API calls from a non-local IP to port 8080 succeed with valid `Authorization: Bearer <token>` header
- [x] SPA login page appears when API returns 401
- [x] Entering valid token on login page stores it and allows access
- [x] Token persists across page reloads (localStorage)
- [x] WebSocket on web port works for local connections
- [x] Primary port (3456) behavior is unchanged
- [x] Tailscale IPs (100.64.0.0/10) bypass auth on web port

## Notes

- Tailscale detection currently uses only IP range check (100.64.0.0/10). See project memory `web-ui-tailscale-detection-research` for future improvements.
- The auth middleware only applies to API routes and `/ws` — static files and the SPA index.html are always served without auth so the login page can load.
- WebSocket auth uses query parameter (`?token=...`) since custom headers are difficult during WebSocket upgrade.
- The `use-auth.ts` file was originally created as `.ts` but needed to be `.tsx` because it contains JSX. This was fixed during build verification.
