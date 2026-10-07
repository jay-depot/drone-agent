---
tags: [decision, swarm, ui]
related: [drone-coordinator.md, drone-coordinator-ui.md]
---

# 021 — Coordinator Web UI

**Summary**: A React-based web dashboard for the drone-coordinator, providing real-time monitoring of swarm topology, sessions, personas, skills, and wiki pages.

## Context

The coordinator had no visual interface — all management was done via CLI commands (`--approve`, `list-beacons`). As the swarm grows, operators need a real-time dashboard to monitor beacon health, active sessions, and swarm-wide assets.

## Decision

Build a single-page application (SPA) using:

- **React 18** — familiar ecosystem, good fit for real-time data
- **Vite** — fast builds, good DX
- **Tailwind CSS** — utility-first CSS for rapid UI development
- **shadcn/ui** — accessible component primitives (badge, button, card, tabs, table, etc.)
- **React Router** — client-side routing for multiple pages
- **WebSocket** — real-time updates via the coordinator's existing `/ws` endpoint

The UI is served directly by the coordinator via `@fastify/static`, eliminating the need for a separate web server or reverse proxy.

## Key Design Decisions

### 1. WebSocket Provider Pattern

A single `WebSocketProvider` (React context) manages the connection. Components subscribe to message types via a pub/sub pattern rather than each managing their own connection. This avoids duplicate connections and provides a consistent reconnection strategy.

### 2. REST Fallback for Initial Data

Pages fetch initial data via REST (`/beacons`, `/agents/location`) as a fallback in case the WebSocket hasn't connected yet. The WebSocket `initial` message provides the same data once connected.

### 3. Static File Serving

The coordinator serves the built UI from `drone-coordinator-ui/dist/`. Static assets go under `/assets/`, and a SPA fallback handler returns `index.html` for any non-API, non-WebSocket route. This keeps the deployment simple — no separate web server needed.

### 4. Monorepo Integration

The UI is a workspace package (`drone-coordinator-ui`) in the pnpm monorepo. The coordinator resolves the dist path at runtime, checking the monorepo location first, then `node_modules`, then an env var override.

## Tradeoffs

- **+** Simple deployment — no separate web server
- **+** Real-time updates via WebSocket
- **+** Familiar React ecosystem
- **-** Requires a build step (Vite) — not a server-rendered solution
- **-** No authentication layer yet — assumes trusted network
- **-** Limited to monitoring — no management actions from the UI yet

## Related

- [[drone-coordinator]] — The backend
- [[modules/drone-coordinator-ui]] — UI module details
