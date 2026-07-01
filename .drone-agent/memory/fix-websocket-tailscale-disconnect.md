---
key: fix-websocket-tailscale-disconnect
tags:
  - plan
  - bugfix
  - websocket
  - tailscale
  - coordinator
  - completed
created: 2026-07-01T20:28:49.158Z
updated: 2026-07-01T20:33:24.470Z
---

# Fix: WebSocket Disconnect Loop on Tailscale Connections

## Summary

The coordinator's WebSocket endpoint (`/ws`) disconnects immediately after the HTTP upgrade when accessed from a Tailscale-connected laptop. The root cause is an inconsistency between two auth-checking layers: the `onRequest` hook (which trusts Tailscale IPs as "local") and the WebSocket handler (which does not). Since the browser `WebSocket` API cannot set custom HTTP headers, the token must come via query parameter, but even when it does, the handler's check doesn't mirror the hook's local-IP bypass.

## Steps

### Step 1: Export `isLocalRequest` from `web-auth.ts`

**File:** `drone-coordinator/src/web-auth.ts`

Change `function isLocalRequest` to `export function isLocalRequest`.

### Step 2: Import `isLocalRequest` in `index.ts`

**File:** `drone-coordinator/src/index.ts`

Change the import from `./web-auth.js` to include `isLocalRequest`:
```typescript
import { createWebAuthMiddleware, isLocalRequest } from './web-auth.js';
```

### Step 3: Use `isLocalRequest` in the WebSocket handler's auth check

**File:** `drone-coordinator/src/index.ts` (around line 262)

Wrap the existing token-check logic in a local-IP guard:

```typescript
if (opts?.getToken) {
  // Skip token check for local/Tailscale connections (consistent with onRequest hook)
  if (!isLocalRequest(req)) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const queryToken = url.searchParams.get('token');
    const token = opts.getToken();
    if (token && queryToken !== token) {
      const authHeader = req.headers.authorization;
      const headerToken = authHeader?.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;
      if (headerToken !== token && queryToken !== token) {
        socket.close(4001, 'Unauthorized');
        return;
      }
    }
  }
}
```

### Step 4: Build and verify

Run `pnpm build` from the monorepo root. Verify no TypeScript errors.

### Step 5: Restart the coordinator and test

Restart the coordinator process. Connect from the laptop browser via Tailscale. The WebSocket should stay connected.

## Validation Criteria

1. **LSP/TypeScript checks pass** — `pnpm typecheck` (or `pnpm build`) completes with no errors in `drone-coordinator`
2. **WebSocket connects from Tailscale** — browser on laptop shows `connected` status in the UI, and the initial state message (beacons, sessions) is received
3. **WebSocket still requires auth from non-local, non-Tailscale IPs** — a connection from a truly external IP without a valid token is still rejected with code 4001
4. **Local connections still work** — browser on the coordinator host connecting to `http://127.0.0.1:8080/ws` works without a token
5. **`pnpm lint` passes** — no linting errors in the changed files

## Implementation Completed (2026-07-01)

All code changes implemented and committed (278a40a):

- `drone-coordinator/src/web-auth.ts`: Added `export` to `isLocalRequest` function
- `drone-coordinator/src/index.ts`: Added `isLocalRequest` to import from `./web-auth.js`
- `drone-coordinator/src/index.ts`: Wrapped WebSocket token check in `if (!isLocalRequest(req))` guard
- `pnpm build` passed with zero errors across all packages
- Ready for Step 5: restart coordinator and test from laptop browser