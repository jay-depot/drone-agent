---
key: coordinator-web-ui-plan
tags:
  []
created: 2026-06-30T02:05:30.457Z
updated: 2026-06-30T02:05:30.457Z
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

### Step 1: Scaffold `drone-coordinator-ui` package

**Agent:** coder

Create the new package directory and its `package.json`:

```
drone-coordinator-ui/
├── package.json
├── tsconfig.json
├── tsconfig.node.json
├── vite.config.ts
├── index.html
├── tailwind.config.ts
├── postcss.config.js
├── src/
│   ├── main.tsx
│   ├── App.tsx
│   ├── index.css
│   ├── lib/
│   │   └── utils.ts          # shadcn cn() helper
│   ├── hooks/
│   │   └── use-websocket.ts  # WebSocket connection hook
│   ├── components/
│   │   └── ui/               # shadcn/ui components (installed via CLI)
│   └── pages/
│       ├── topology.tsx
│       ├── sessions.tsx
│       ├── session-detail.tsx
│       ├── personas.tsx
│       ├── skills.tsx
│       └── wiki.tsx
```

**package.json** key fields:
```json
{
  "name": "drone-coordinator-ui",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "typecheck": "tsc -b --pretty false"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-router-dom": "^7.0.0",
    "lucide-react": "^0.400.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.5.0",
    "class-variance-authority": "^0.7.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "vite": "^6.0.0",
    "typescript": "^5.9.0",
    "tailwindcss": "^4.0.0",
    "postcss": "^8.4.0",
    "autoprefixer": "^10.4.0"
  }
}
```

**vite.config.ts** — set `base: '/'` and configure the dev server proxy to forward `/api/*` and `/ws` to the coordinator.

**tsconfig.json** — extends the base, but uses `"jsx": "react-jsx"`, `"lib": ["ES2022", "DOM", "DOM.Iterable"]`, `"module": "ESNext"`, `"moduleResolution": "bundler"`.

Add `drone-coordinator-ui` to `pnpm-workspace.yaml`.

### Step 2: Install shadcn/ui and tweakcn theme

**Agent:** coder

1. Run `pnpm dlx shadcn@latest init` inside `drone-coordinator-ui/` to set up shadcn/ui (choose CSS variables, Tailwind v4, neutral gray, etc.)
2. Run `pnpm dlx shadcn@latest add button card badge table tabs separator scroll-area collapsible` to install the components we'll use
3. Apply a tweakcn theme by pasting the CSS variables into `src/index.css` (or use the `tweakcn-theme-picker` package)
4. Set up `src/lib/utils.ts` with the standard `cn()` helper

### Step 3: Add WebSocket support to coordinator

**Agent:** coder

**Files to modify:**
- `drone-coordinator/package.json` — add `@fastify/websocket` and `@fastify/static` dependencies
- `drone-coordinator/src/index.ts` — register the plugins and serve the UI

**Key changes in `index.ts`:**

```typescript
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';

// After creating the app:
await app.register(fastifyWebsocket);

// Serve the UI static files
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uiDistPath = path.resolve(__dirname, '../../drone-coordinator-ui/dist');
await app.register(fastifyStatic, {
  root: uiDistPath,
  prefix: '/',
  wildcard: false, // We'll handle SPA fallback manually
});

// SPA fallback: serve index.html for all non-API routes
app.setNotFoundHandler(async (request, reply) => {
  if (request.url.startsWith('/api/') || request.url.startsWith('/ws')) {
    return reply.code(404).send({ error: 'Not found' });
  }
  return reply.sendFile('index.html');
});

// WebSocket endpoint for real-time events
app.register(async function (fastify) {
  fastify.get('/ws', { websocket: true }, (socket, req) => {
    // Send initial state snapshot
    socket.send(JSON.stringify({
      type: 'initial',
      data: { beacons: db.listBeacons(), /* ... */ }
    }));
    
    // Keep-alive
    const interval = setInterval(() => {
      socket.send(JSON.stringify({ type: 'ping' }));
    }, 30000);
    
    socket.on('close', () => clearInterval(interval));
  });
});
```

**Note on path resolution:** The `uiDistPath` needs to work both in development (monorepo layout) and when published to npm. Use `import.meta.resolve` or a configurable env var `UI_DIST_PATH` as a fallback. The simplest approach for the monorepo: resolve relative to the coordinator's `dist/` location, and for npm, look in `node_modules/drone-coordinator-ui/dist/`.

### Step 4: Build the WebSocket hook

**Agent:** coder

Create `src/hooks/use-websocket.ts`:

```typescript
// Manages a WebSocket connection to the coordinator
// Reconnects on disconnect
// Dispatches events to registered handlers by type
// Returns: { status, lastMessage, subscribe(type, handler) }
```

The hook should:
- Connect to `ws://${window.location.host}/ws` (or `wss://` for HTTPS)
- Auto-reconnect with exponential backoff
- Allow components to subscribe to specific event types
- Track connection status (connecting, connected, disconnected)

### Step 5: Build the Swarm Topology page

**Agent:** coder

**File:** `src/pages/topology.tsx`

- Fetches `GET /beacons` on mount
- Subscribes to WebSocket for real-time beacon heartbeat updates
- Displays a card grid, one per beacon
- Each card shows: beacon name, ID, host:port, trust status badge (approved/pending/rejected), online/offline indicator, active agent count
- Agent count comes from `GET /agents/location?beaconId=<id>` or is included in the WebSocket initial payload

### Step 6: Build the Sessions page

**Agent:** coder

**File:** `src/pages/sessions.tsx`

- Fetches active sessions from the coordinator
- Displays a table: Beacon Name | Agent ID | Persona | Connected Since | Actions
- "Peek" action navigates to `/sessions/:sessionId`
- Real-time updates via WebSocket (new sessions appear, sessions close)

### Step 7: Build the Session Detail page

**Agent:** coder

**File:** `src/pages/session-detail.tsx`

- Fetches `GET /sessions/:id/events` on mount
- Subscribes to WebSocket for new events for this session
- Displays events in reverse-chronological order
- Each event is a collapsible card showing: type, timestamp, correlationId
- Click to expand: shows full payload and metadata (formatted JSON)
- Auto-scrolls to latest events
- Shows session metadata at top (beacon, agent, persona, status)

### Step 8: Build the Personas, Skills, and Wiki pages

**Agent:** coder

**Files:** `src/pages/personas.tsx`, `src/pages/skills.tsx`, `src/pages/wiki.tsx`

Each page:
- Fetches the corresponding list endpoint on mount
- Displays a table or card list
- Personas: name, description, scope, created/updated dates
- Skills: name, description, trigger, scope
- Wiki: title, scope, tags, last updated
- Read-only for now (no create/edit/delete UI)

### Step 9: Wire up routing and navigation

**Agent:** coder

**File:** `src/App.tsx`

```tsx
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
// Layout with sidebar navigation
// Routes for each page
// Active nav link highlighting
```

Layout structure:
- Left sidebar with nav links (Topology, Sessions, Personas, Skills, Wiki)
- Main content area
- Status bar showing WebSocket connection status
- Responsive design

### Step 10: Add coordinator route for session events WebSocket subscription

**Agent:** coder

Extend the WebSocket handler to support per-session subscriptions:

```typescript
// Client sends: { type: 'subscribe', sessionId: '...' }
// Server responds with new events as they arrive for that session
// Client sends: { type: 'unsubscribe', sessionId: '...' }
```

The coordinator already has `createSwarmEvent` in `db.ts`. We need to hook into event creation to push to connected WebSocket clients. This can be done with a simple in-memory pub/sub:

```typescript
const subscribers = new Map<string, Set<WebSocket>>();

// When an event is created:
const subs = subscribers.get(event.sessionId);
if (subs) {
  for (const ws of subs) {
    ws.send(JSON.stringify({ type: 'event', sessionId: event.sessionId, event }));
  }
}
```

### Step 11: Add CORS support for development

**Agent:** coder

In `drone-coordinator/src/index.ts`, add `@fastify/cors` for development mode:

```typescript
import cors from '@fastify/cors';

if (process.env.NODE_ENV === 'development') {
  await app.register(cors, { origin: true });
}
```

Add `@fastify/cors` to the coordinator's `package.json`.

### Step 12: Update root tsconfig.json references

**Agent:** coder

Add the UI package to the root `tsconfig.json` references if it uses TypeScript project references (Vite projects typically don't, so this may be a no-op or we skip it).

### Step 13: Verify the build

**Agent:** tester

1. Run `pnpm build` from the monorepo root — verify all packages compile
2. Start the coordinator: `cd drone-coordinator && pnpm start`
3. Open `http://localhost:3456/` — verify the UI loads
4. Verify all pages render with data (or graceful empty states)
5. Verify WebSocket connection is established (check browser devtools)
6. Run `pnpm lint` — verify no new issues
7. Run `pnpm typecheck` — verify type safety

### Step 14: Check the work against validation criteria

**Agent:** reviewer

- [ ] `pnpm build` succeeds
- [ ] `pnpm typecheck` passes (or UI package is excluded with explanation)
- [ ] `pnpm lint` passes
- [ ] Coordinator serves UI at root URL
- [ ] WebSocket connects and streams events
- [ ] Topology page shows beacons with agent counts
- [ ] Sessions page lists open sessions
- [ ] Session detail page shows events with collapsible payloads
- [ ] Personas, Skills, Wiki pages show read-only lists
- [ ] SPA routing works (direct URL access, back/forward navigation)
- [ ] Empty states handled gracefully (no beacons, no sessions, etc.)
