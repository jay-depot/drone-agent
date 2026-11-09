---
tags:
  [
    decision,
    drone-coordinator-ui,
    swarm-extension,
    routing,
    front-end-bundle,
    error-boundary,
    bug-fix,
  ]
related:
  [
    272-extension-routes-first-class-nav.md,
    254-swarm-extensions.md,
    271-drone-swarm-project-kanban-extension.md,
    modules/drone-coordinator-ui.md,
  ]
---

# ADR 273: The extension registry is mount-stable — refs for `navigate`, a disposer ref, and a render-error boundary

**Status**: Implemented (2026-11-09, branch `feat/kanban-extension-base`)

## Context

ADR [272](272-extension-routes-first-class-nav.md) made extension routes
first-class. The `drone-swarm-project` board bundle declared `/board`, and the
host drew a "Board" `NavLink` in the sidebar. A full page load of `/board`
worked. But a **click** on the "Board" link still returned to `/` and removed
the link. Nothing appeared in the console.

The cause is not the bundle, and it is not an empty project list. The cause is
this: the extension registry is **torn down on every navigation, and it is
never rebuilt**.

The chain:

1. `useNavigate()` from react-router 7.18.3 returns a function whose identity
   changes when the path changes. Its `useCallback` depends on
   `locationPathname`.
2. `useExtensions` built `load` as `useCallback(..., [authFetch, navigate])`. So
   the identity of `load` changed on every navigation.
3. `ExtensionProvider`'s effect depends on `extensions.load`. So the effect ran
   again on every navigation.
4. The effect cleanup called every disposer. That removed the `/board` route and
   every region component from the registry.
5. The effect ran again and called `load`. But `didLoadRef.current` was already
   `true`. So `load` returned an empty disposer array at once and registered
   nothing.

Result: `/board` left the route table. The catch-all `ExtensionRouteFallback`
then ran with `loading === false` and redirected to `/`. At the same time, the
host-drawn "Board" link disappeared, because it renders from `pluginRoutes`.
Both symptoms, one cause. It is deterministic.

The teardown was silent by design. Cleanup is not an error path, so nothing
threw and nothing logged.

ADR [272](272-extension-routes-first-class-nav.md) did not catch this, because
`App.test.tsx` rendered once at `/board` and never navigated. A render crash in
a page also had no visible surface — the app had no error boundary, so a crash
would blank the main region with no message.

## Decision

Amends ADR [272](272-extension-routes-first-class-nav.md) D7 and the
`ExtensionProvider` contract.

### D1 — `load` is reference-stable

`useExtensions` holds `navigate` and `authFetch` in refs. The refs stay fresh in
a `useEffect`. `load` reads the refs, so its dependency list is `[]`. The
provider effect therefore runs only at mount.

### D2 — The provider tracks disposers in a persistent ref

The provider pushes each disposer into a `disposersRef`. The cleanup disposes
the ref and then clears it. The register callbacks wrap the registry callbacks,
push the disposer, and return it.

A `cancelled` boolean flag is **not** used. A `cancelled` flag breaks React
StrictMode: the simulated unmount sets the flag, `didLoadRef` prevents
re-registration, and a late registration would be disposed at once. The
ref-reset form is StrictMode-safe: the simulated unmount disposes an as-yet-empty
ref, the late registration lands in the fresh ref, and the real unmount disposes
it.

### D3 — A reusable `ErrorBoundary` wraps `<Routes>`, keyed by pathname

A new class component `src/components/error-boundary.tsx` catches a render error
in its subtree. `App.tsx` wraps `<Routes>` inside `<main>` with a
`KeyedErrorBoundary` that keys the boundary on `useLocation().pathname`. The
sidebar stays usable for recovery. A second outer boundary over the whole app
shell is deferred.

### D4 — The boundary shows a house-style panel and logs the error

The panel is centered, in the `ErrorBanner` style: the heading "Something went
wrong", the caught message, and a "Try again" button that resets the boundary.
The error and the component stack go to `console.error`.

## Consequences

- Extension routes and their nav links survive navigation. The registry is built
  once and disposed only at unmount.
- A render crash shows a visible panel with a reset, instead of a silent blank
  area. The error and component stack reach `console.error`.
- A StrictMode dev run no longer leaks disposers.
- Tests: an App-level navigation regression, an `ErrorBoundary` unit test, and a
  `useExtensions` load-stability unit test.

## Out of scope

- A second outer error boundary over the whole app shell (deferred).
- A dev-mode `console.warn` tripwire when the registry is disposed by a re-run
  (the fix removes the re-run).
- A user-managed extension nav list (deferred in ADR
  [272](272-extension-routes-first-class-nav.md)).
