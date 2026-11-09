---
tags:
  [
    decision,
    drone-coordinator-ui,
    swarm-extension,
    routing,
    front-end-bundle,
    bug-fix,
  ]
related:
  [
    254-swarm-extensions.md,
    271-drone-swarm-project-kanban-extension.md,
    modules/drone-swarm-project.md,
  ]
---

# ADR 272: Extension routes are first-class — gated catch-all, host-owned nav, `api.navigate`

**Status**: Implemented (2026-11-09, branch `feat/kanban-extension-base`)

## Context

ADR [254](254-swarm-extensions.md) lets a front-end bundle contribute client
routes (`{ path, title, component }`). The `drone-swarm-project` board bundle
(ADR [271](271-drone-swarm-project-kanban-extension.md)) declared `/board`, but
opening `/board` always landed back on `/`. The board never showed.

The cause is a load race in the coordinator UI. The app builds its route table
at the first render. Extension routes arrive later, because they come from an
async bundle load (`GET /api/extensions` then a dynamic `import()`). Until they
arrive, `/board` matches the catch-all:

```tsx
<Route path="*" element={<Navigate to="/" replace />} />
```

`<Navigate>` runs its effect at commit time; the bundle load finishes much
later. So the redirect always wins. It is deterministic, not a flake.

`mcp-swarm` (the only other bundle) declares no routes, only regions. So no
test ever exercised this path before `drone-swarm-project`.

Two further papercuts surrounded the bug:

- The board bundle drew its own nav link as a plain `<a href="/board">`. A plain
  anchor is a full page reload, so the race re-fired on every sidebar click and
  the link's styling drifted from the core nav.
- `useExtensions` exposed a `loaded` ref that did not trigger a re-render, so
  nothing could gate routing on the load state.

## Decision

Extension routes become first-class routes. Amends ADR
[254](254-swarm-extensions.md) D7 (bundle contract) and D11 (UI regions).

### D1 — The catch-all is gated, not removed

A "not-yet-known route" must not redirect while bundles load. The `path="*"`
element becomes `ExtensionRouteFallback`.

### D2 — While bundles load, the catch-all shows a `Skeleton` placeholder

House style, matching the other pages in the repo.

### D3 — The gate wraps only the `path="*"` element

Core routes (`/sessions`, `/wiki`, and the others) still render at once. Only
an unmatched path pays the load wait.

### D4 — The host renders one sidebar `NavLink` per registered extension route

The label is `route.title`. The classes and the `isActive` logic match the core
nav items. A bundle must **not** draw its own sidebar entry — the host owns nav
rendering and styling.

### D5 — `UIExtensionApi` gains `navigate(path)`

A bundle navigates client-side with `api.navigate(path)`. Same shape as the
existing `api.fetch`. This removes the bundle's need for a plain `<a href>`
(which cannot import `react-router-dom` — only react/react-dom are external and
shared via `globalThis.React`).

### D6 — The board bundle drops its own nav link

`BoardNav.tsx` and its `sidebar-nav` registration are deleted. Otherwise two
"Board" links appear.

### D7 — `loading` becomes reactive

`useExtensions` exposes a reactive `loading` boolean (settled in a `finally`,
so it always clears — on a failed fetch and on a rejected import alike). The
provider publishes it; the fallback reads it.

## Consequences

- A full page load of `/board` shows the board. The app does not return to `/`.
- `/sessions` and `/wiki` render at once; they do not wait for the bundles.
- The sidebar shows one host-styled "Board" link. A click navigates
  client-side, with no page reload.
- An unknown path still goes to `/`, but only after the bundles settle.
- `<BrowserRouter>` moves above `<ExtensionProvider>` (load-bearing: the
  provider now calls `useNavigate`).
- Deferred: a user-managed extension nav list (the swarm user with many
  extensions).
