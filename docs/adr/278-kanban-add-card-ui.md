---
tags:
  [
    decision,
    drone-swarm-project,
    drone-coordinator-ui,
    swarm-extension,
    front-end-bundle,
    kanban,
    card-create,
    modal-shell,
    button-variant,
  ]
related:
  [
    271-drone-swarm-project-kanban-extension.md,
    274-card-modal-and-drone-ui-error-api.md,
    275-kanban-project-create-and-edit-ui.md,
    277-kanban-bundle-host-theme-tokens.md,
    modules/drone-swarm-project.md,
    modules/drone-coordinator-ui.md,
  ]
---

# ADR 278: Add a card from the kanban board

**Status**: Implemented (2026-11-13, branch `feat/kanban-addon-card-ui`)

## Context

The `drone-swarm-project` board bundle can move and edit cards (ADR
[274](274-card-modal-and-drone-ui-error-api.md)) and create and edit projects
(ADR [275](275-kanban-project-create-and-edit-ui.md)). It **cannot create a
card**. The `card.create` capability exists. It is `mcp`-tier. The web UI can
call it. No UI code calls it.

Three modals — `ProjectModal`, `CardModal`, and `QueueModal` — each repeated the
same shell markup: a backdrop `div`, a panel `div` that stops propagation, a
header `div` with an `<h2>` and a Close button, and an Escape `keydown` effect.

## Decision

### D1 — An "Add card" button sits at the bottom of every column

The button is a **ghost** button. It is full width. It is always visible. Its
label is `+ Add card`. A click opens a new-card modal.

### D2 — The target column is the column whose button was clicked

The modal shows the column name as read-only text. There is no column picker.

### D3 — The modal has a Title field and a Description field

Both go to `card.create`.

### D4 — On success the modal closes, the board reloads, and the project list reloads

The project list reloads because the dropdown shows a card count.

### D5 — A shared `Modal` shell owns the chrome

`Modal` owns the backdrop, the panel, the header (an `<h2>` with the title and a
Close button), and the Escape listener. The children are the body only.
`ProjectModal`, `CardModal`, and `QueueModal` use the shell. The rendered DOM
does not change, so their tests do not change.

### D6 — `Button` gains a third variant, `ghost`

`ghost` is low emphasis, for the add-card button. The default stays outline.
`primary` stays filled.

### D7 — The Title input is focused on open

`autoFocus`.

### D8 — Each button has a unique accessible name

`Add card to <column name>`.

### D9 — A create can fire an automation

`card.create` already calls `enqueueForMove(project, card, null, card.columnId)`.
So a wildcard-from automation (`* → <column>`) matches, and a job is enqueued.
This is **accepted**: card creation is an arrival in the column.

## Consequences

- The UI can call `card.create`. A card created by the UI records `actor: 'user'`.
- The `Modal` shell is a shared primitive with four consumers.
- Creating a card can start a session, but only through a matching
  wildcard-from automation (D9). A create does not start a session by itself.

## Does not amend

An earlier ADR. It extends ADR [271](271-drone-swarm-project-kanban-extension.md)
and follows ADRs [274](274-card-modal-and-drone-ui-error-api.md) and
[277](277-kanban-bundle-host-theme-tokens.md).

## Out of scope

- A column picker in the modal.
- Card delete. No `card.delete` capability exists.
- A "create another" mode.
- A card-bound session started directly by the create.
- A repair of the `docs/adr/index.md` duplicates.
- A change to the `card.create` handler or its enqueue behaviour.
