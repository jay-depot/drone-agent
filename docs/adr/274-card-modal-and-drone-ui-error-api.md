---
tags:
  [
    decision,
    drone-swarm-project,
    drone-coordinator-ui,
    swarm-extension,
    front-end-bundle,
    card-modal,
    error-api,
  ]
related:
  [
    271-drone-swarm-project-kanban-extension.md,
    254-swarm-extensions.md,
    273-extension-registry-navigation-teardown.md,
    modules/drone-swarm-project.md,
    modules/drone-coordinator-ui.md,
  ]
---

# ADR 274: The card modal for the kanban bundle, and a `DroneUI` error API

**Status**: Implemented (2026-11-10, branch `feat/kanban-extension-base`)

## Context

The `drone-swarm-project` kanban extension declares **23 capabilities** (ADR
[271](271-drone-swarm-project-kanban-extension.md)). The web UI uses only nine.
A user can drag a card between columns, but the user **cannot open a card**,
**cannot read its description**, and **cannot change its title or description**.

The bundle also has **no error handling**. Every `action()` call ignores a
failure. The bundle cannot import the host `ErrorBanner` or the toast, because
only React is shared with the bundle.

`POST /api/extensions/:nodeId/actions/:action` runs the caller as `ui`, so the
web UI can call any capability, including the two that the modal needs:
`card.get` and `card.update`. No capability change is needed.

## Decision

### D1 — The card modal opens on a click, not on a drag

A click opens the modal. A drag does not. A `didDrag` ref is set in
`onDragStart`, cleared on the next tick in `onDragEnd`, and checked in
`onClick`. A plain click never sets the flag.

### D2 — The modal is seeded from the loaded card and frozen against the poll

The modal is seeded from the already-loaded card prop. It does not call
`card.get`. The editable fields are initialized **once** into local state, so
the three-second board poll cannot overwrite what the user types. On Save: call
`card.update`, then reload the board and close.

### D3 — `UIExtensionApi` gains `ui: DroneUI`

`DroneUI` is a bag of sub-objects keyed by area. The first sub-object is
`errors`. The change is additive; `mcp-swarm` needs no change.

### D4 — `DroneUI.errors` has three methods

`show(message)`, `fromResponse(res)`, and `fromThrown(err)`. All three report
through the host error toast. `fromResponse` and `fromThrown` return the
normalized message, so a caller can show the same message inline and in the
toast. A fire-and-forget caller ignores the return value.

### D5 — The host toast moves above extension modals

The bundle modal backdrop is `position: fixed` with `z-index: 1000`. The toast
viewport was `z-50`, so a toast shown from inside a modal was hidden behind the
backdrop. The viewport is now `z-[1100]`. Host UI must always sit above
extension UI; the fix is correct for all extensions, not only this one.

### D6 — Card deletion is out of scope

No `card.delete` capability exists. It needs a new capability, a store method,
and a handler case. It stays deferred.

## Consequences

- `card.get` and `card.update` become reachable from the UI.
- A bundle can report an error without its own error surface.
- The change is additive; `mcp-swarm` is unaffected.
- `ExtensionProvider` calls `useToast()` and threads the toast function
  ref-stable through `useExtensions` (like `navigate`), so `load` stays
  reference-stable (ADR [273](273-extension-registry-navigation-teardown.md)).

## Amends

ADR [254](254-swarm-extensions.md) D7 (the bundle API contract).

## Out of scope

- Card deletion.
- `card.create`, project create/update/delete, column rename/reorder, the
  automation editor, and positional reorder.
- A version-skew guard for an old host without `api.ui`. The host and the bundle
  ship from one repository and deploy together.
