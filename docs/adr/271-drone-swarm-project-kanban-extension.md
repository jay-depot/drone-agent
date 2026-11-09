---
tags:
  [
    decision,
    drone-swarm-project,
    swarm-extension,
    kanban,
    automation,
    scheduler,
    esbuild,
  ]
related:
  [
    modules/drone-swarm-project.md,
    254-swarm-extensions.md,
    257-extension-node-web-port-transport.md,
    270-gateway-agent-self-scheduling.md,
  ]
---

# ADR 271: `drone-swarm-project` — kanban board swarm extension

**Status**: Implemented (2026-11-09, branch `feat/kanban-extension-base`)

## Context

ADR [254](254-swarm-extensions.md) gave the swarm a way for an external service
to become a first-class participant: a **swarm extension** is a beacon that
declares a capability manifest, receives session lifecycle events, injects
fragments/reminders/tools into agent sessions, and ships a front-end bundle.
`mcp-swarm` was the first reference extension, but it embeds its UI as a
hand-written JS string and does no agent orchestration.

We wanted to drive agent work from a board: a human moves a card, an agent
starts, the agent does the work and moves the card. The extension must control
the **speed** of the spawns so a human can intervene.

## Decision

A new workspace package `drone-swarm-project` — a swarm extension node that owns
a kanban board.

### D1 — A card move enqueues a paced spawn, not an immediate spawn

Every matching transition **enqueues a job**. A drain loop starts jobs under
three gates: concurrency (`maxConcurrentSessions`, default 1), a rolling-24h
cap (`maxDailySessions`, default 12), and spacing (`24h / maxDailySessions`,
2h by default). Enqueue always succeeds; the queue may hold more jobs than the
daily cap. This lets a burst of card moves queue up without any being thrown
away, while the starts stay paced.

**Persist actual start timestamps and derive the 24h window on read.** Never
keep the pacing in an in-memory counter or a `setInterval` that a restart
resets, or the pacing silently re-arms after every bounce.

### D2 — Limits constrain speed, not the actor

The limits do **not** care who moved the card. `actor` (`user`/`agent`) is
recorded on every move for display and audit — it gates nothing. This was a
deliberate rejection of actor-gated automations: the goal is time for human
intervention, not a rule about who may trigger work.

### D3 — The card does not auto-advance on session end

When a session ends the job closes (`done`, or `failed`) and the card keeps its
`sessionId`/`spawnId` as history. The agent moves the card itself with
`card_move`, because the rendered `promptTemplate` told it to. Three reasons: a
reviewer may reject a card **backwards**, which no fixed rule can know; an
auto-move is itself a transition and would fire the next automation, rebuilding
the unbounded chain the speed limits exist to prevent; and the transition table
stays fully human-authored.

### D4 — The first real esbuild TSX bundle

`mcp-swarm` embeds its panels as a JS string using
`globalThis.React.createElement`. That is fine for two small panels and
miserable for a kanban board with drag-and-drop, modals, and polling. So the
board UI is authored as TSX under `bundle/` (its own typecheck-only `tsconfig`),
built with **esbuild** into `dist/bundle/index.js`. React is shared via
`globalThis.React` (react/react-dom are `external`), so the bundle never
imports react at runtime. This bundle is the **worked example** of a real TSX
extension bundle.

### D5 — JSON store behind an interface, SQLite reserved

One JSON file per project plus an index and one queue file, all accessed
through `BoardStore`/`SchedulerStore` interfaces. In-memory state is the source
of truth; every write goes through `withPathLock` plus a tmp-file rename. A
later SQLite implementation can drop in behind the same interfaces.

### D6 — Board/card management is `mcp`-tier; everything else is `ui`-tier

`project.list`, `board.get`, `card.get`, `card.create`, `card.update`,
`card.move` are agent-callable. Columns, automations, limits, and queue
administration are `ui`-tier — never agent-callable.

### D7 — Card tools are injected into every top-level session, unmounted

A node option `injectToolsIntoAllSessions` (default `true`) injects the six
card tools into every top-level session. Subagent sessions are skipped.
Injections are **unmounted**, so persona globs (`!extensions__*`) keep working.
A card-bound session (`extensionHint` `drone-swarm-project:card:<cardId>`) may
omit `projectId`/`cardId`, and gets a one-time fragment naming its card.

## Consequences

- A burst of card moves queues jobs instead of starting them; the board shows a
  colour-coded status pill per card and a queue modal for administration.
- A restart keeps the pace (persisted `startedAt`, window derived on read). A
  `running` job whose session vanished after a restart becomes `failed` after a
  30s settle window (the coordinator replays `sessionStarted` on connect, so a
  live session confirms itself).
- The bundle build is a new step (`node scripts/build-bundle.mjs`) after
  `tsc -b`; a missing bundle is non-fatal (logged and skipped), exactly like
  `mcp-swarm`.
- Docker images are deferred (the `mcp-swarm`/`drone-swarm` precedent), so the
  integration tests do not run in `pnpm test:integration`.
