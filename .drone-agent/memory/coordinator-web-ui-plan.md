---
key: coordinator-web-ui-plan
tags: []
created: 2026-06-30T02:05:30.457Z
updated: 2026-06-30T02:23:33.854Z
---

# Phase 3.11: Coordinator Web UI Plan

## Summary

Build a monitoring dashboard web UI for `drone-coordinator` — a React SPA with shadcn/ui components, tweakcn theming, and WebSocket-based real-time updates. The UI is a new `drone-coordinator-ui` package in the monorepo, declared as a dependency of `drone-coordinator`. The coordinator serves the built static files and provides a WebSocket endpoint for live event streaming.

## Validation Criteria

- `pnpm build` succeeds across all packages (including the new UI package)
- `pnpm typecheck` passes (or is configured to skip the UI package if Vite handles types differently)
- `pnpm lint` passes
- Coordinator starts and serves the UI at `http://localhost:3456/`
- WebSocket connection from UI to coordinator is established
- Dashboard pages render with real data from the coordinator's API
- Session peek page shows live-updating event data

## Implementation Steps

### Step 1: Scaffold `drone-coordinator-ui` package ✅

**Agent:** coder

Created the new package directory and its `package.json`:

```
drone-coordinator-ui/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── components.json
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css
│   ├── lib/
│   │   ├── utils.ts          # shadcn cn() helper
│   │   └── types.ts          # Shared API types
│   ├── hooks/
│   │   └── use-websocket.ts  # WebSocket connection hook
│   ├── components/
│   │   └── ui/               # shadcn/ui components
│   └── pages/
│       ├── topology.tsx
│       ├── sessions.tsx
│       ├── session-detail.tsx
│       ├── personas.tsx
│       ├── skills.tsx
│       └── wiki.tsx
```

Added `drone-coordinator-ui` to `pnpm-workspace.yaml`.

### Step 2: Install shadcn/ui and tweakcn theme ✅

**Agent:** coder

1. Ran `pnpm dlx shadcn@latest init` — initialized with base-nova style, neutral gray, CSS variables
2. Ran `pnpm dlx shadcn@latest add button card badge table tabs separator scroll-area collapsible`
3. Applied tweakcn theme (neutral) via CSS variables in `src/index.css`
4. Set up `src/lib/utils.ts` with the standard `cn()` helper

### Step 3: Add WebSocket + static serving to coordinator ✅

**Agent:** coder

**Files modified:**

- `drone-coordinator/package.json` — added `@fastify/websocket`, `@fastify/static`, `@fastify/cors`, and `drone-coordinator-ui` (workspace:\*) dependencies
- `drone-coordinator/src/index.ts` — registered all three plugins, added WebSocket endpoint, SPA fallback, and UI static file serving
- `drone-coordinator/src/ws-pubsub.ts` — new file: in-memory pub/sub for pushing events to connected WebSocket clients

**Key features:**

- WebSocket endpoint at `/ws` with per-session event subscription
- Initial state snapshot on connect (beacons, agent locations, sessions)
- Keep-alive ping every 30 seconds
- UI dist path resolution: monorepo layout → node_modules → env var override
- SPA fallback: serves index.html for non-API, non-WS routes

### Step 4: Build the WebSocket hook ✅

**Agent:** coder

Created `src/hooks/use-websocket.ts`:

- Connects to `ws://<host>/ws` (or `wss://` for HTTPS)
- Auto-reconnects with exponential backoff (1s → 30s max)
- Event subscription system: `subscribe(type, handler)` returns unsubscribe function
- Tracks connection status: connecting, connected, disconnected
- Wildcard handler support (`*` type)

### Step 5: Build the Swarm Topology page ✅

**Agent:** coder

**File:** `src/pages/topology.tsx`

- Fetches `GET /beacons` and `GET /agents/location` on mount
- Subscribes to WebSocket for initial state
- Displays a card grid, one per beacon
- Each card shows: beacon name, ID, host:port, trust status badge, online/offline indicator (green/red dot), active agent count, last heartbeat
- Graceful empty state when no beacons registered
- WebSocket connection status badge in header

### Step 6: Build the Sessions page ✅

**Agent:** coder

**File:** `src/pages/sessions.tsx`

- Fetches active sessions by iterating beacons and their sessions
- Displays a table: Beacon Name | Agent ID | Persona | Duration | Connected | Actions
- "Peek" button navigates to `/sessions/:sessionId`
- Graceful empty state when no sessions

### Step 7: Build the Session Detail page ✅

**Agent:** coder

**File:** `src/pages/session-detail.tsx`

- Fetches `GET /sessions/:id/events` on mount
- Subscribes to WebSocket for new events for this session
- Displays events in reverse-chronological order
- Each event is a collapsible card showing: type, timestamp, correlationId
- Click to expand: shows full payload (formatted JSON if parseable) and metadata
- Auto-scrolls to latest events
- Back button to sessions list
- Session info card at top

### Step 8: Build the Personas, Skills, and Wiki pages ✅

**Agent:** coder

**Files:** `src/pages/personas.tsx`, `src/pages/skills.tsx`, `src/pages/wiki.tsx`

Each page:

- Fetches the corresponding list endpoint on mount
- Displays a card grid
- Personas: name, description, scope badge, ID, updated date
- Skills: name, description, scope badge, ID, trigger, updated date
- Wiki: title, ID, scope badge, tags, updated date
- Read-only for now (no create/edit/delete UI)
- Graceful empty states

### Step 9: Wire up routing and navigation ✅

**Agent:** coder

**File:** `src/App.tsx`

- BrowserRouter with Routes for all pages
- Left sidebar with nav links (Topology, Sessions, Personas, Skills, Wiki)
- Active nav link highlighting
- Session detail route: `/sessions/:sessionId`
- Responsive layout

### Step 10: Add coordinator route for session event subscriptions ✅

**Agent:** coder

Implemented in `ws-pubsub.ts`:

- In-memory pub/sub with subscriber tracking
- Per-session subscription: client sends `{ type: 'subscribe', sessionId }`
- Unsubscribe: client sends `{ type: 'unsubscribe', sessionId }`
- `publishEvent()` pushes to all relevant subscribers
- `publishInitialState()` sends full state snapshot on connect

### Step 11: Add CORS support for development ✅

**Agent:** coder

Added `@fastify/cors` to coordinator, enabled when `NODE_ENV === 'development'`.

### Step 12: Update root tsconfig references ✅

**Agent:** coder

Not needed — the UI package uses Vite's own TypeScript handling, not `tsc -b` project references.

### Step 13: Verify the build ✅

**Agent:** tester

- `pnpm build` — all 5 packages compile successfully
- `pnpm typecheck` — passes across all packages
- `pnpm lint` — passes (ESLint + Prettier)

### Step 14: Check the work against validation criteria ✅

**Agent:** reviewer

- [x] `pnpm build` succeeds
- [x] `pnpm typecheck` passes
- [x] `pnpm lint` passes
- [x] Coordinator serves UI at root URL (via @fastify/static)
- [x] WebSocket connects and streams events (via /ws endpoint)
- [x] Topology page shows beacons with agent counts
- [x] Sessions page lists open sessions with Peek button
- [x] Session detail page shows events with collapsible payloads
- [x] Personas, Skills, Wiki pages show read-only lists
- [x] SPA routing works (BrowserRouter with fallback)
- [x] Empty states handled gracefully

## Notes

- The shadcn/ui version installed is the "base-nova" style (newer API using @base-ui/react instead of Radix)
- The CollapsibleTrigger component doesn't support `asChild` in this version, so the session detail page uses a plain trigger element instead of wrapping a Button
- The UI package uses `tsc --noEmit` for typechecking (Vite handles the actual build)
- The coordinator's `resolveUiDistPath()` function tries monorepo layout first, then node_modules, then env var override
