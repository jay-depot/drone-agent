---
tags:
  [
    decision,
    drone-swarm-project,
    drone-coordinator-ui,
    swarm-extension,
    front-end-bundle,
    kanban,
    project-create,
    project-update,
  ]
related:
  [
    271-drone-swarm-project-kanban-extension.md,
    274-card-modal-and-drone-ui-error-api.md,
    modules/drone-swarm-project.md,
    modules/drone-coordinator-ui.md,
  ]
---

# ADR 275: Create and edit projects in the kanban bundle

**Status**: Implemented (2026-11-10, branch `feat/kanban-extension-base`)

## Context

The `drone-swarm-project` board bundle can move and edit cards (ADR
[274](274-card-modal-and-drone-ui-error-api.md)), but it **cannot create or edit
a project**. The `project.create` and `project.update` capabilities exist and are
`ui`-tier, so the web UI can already call them. No UI code calls them.

A project carries `defaultBeaconId` and `defaultWorkingDir`. An automation
**inherits** these two values. Nothing can override them yet. So the values must
be set at the project.

The board page and the settings panel each duplicated a project `<select>` and
its list logic.

## Decision

### D1 — The dropdown gains a `New Project…` sentinel

The project dropdown on **both** pages gains `New Project…` as the last option.
Its value is `__new_project__`. The dropdown is controlled. A pick of the
sentinel opens the modal and does **not** change the selection. The sentinel
value never becomes the selection.

### D2 — The modal has three fields

**Name** (required), **Beacon**, and **Working directory**.

### D3 — The Beacon picker lists connected beacons

The code reads `GET /api/beacons` and keeps `connected === true`.

### D4 — The Working-directory picker lists the beacon's `spawnRoots`

The seed value is `defaultSpawnRoot ?? spawnRoots[0]`. The list is re-seeded when
the beacon changes.

### D5 — Extension nodes are removed from the beacon picker

The coordinator registers an extension node as a beacon, so `GET /api/beacons`
returns extension nodes. They cannot spawn sessions. The code reads
`GET /api/extensions` and removes every node with `isExtension === true`.

### D6 — With no connected beacon, a name-only project can be created

The beacon and working directory stay unset.

### D7 — After a create, the new project is selected

The modal closes and the project list reloads.

### D8 — Edit is a separate button on the board page

The `Edit Project` button sits next to the project dropdown on the **board page
only**. It acts on the **currently selected** project and is **disabled** when no
project is selected. Delete is deferred.

### D9 — One `ProjectModal` serves both modes

The component takes a `mode: 'create' | 'edit'` prop.

### D10 — A stored value that is not live is never lost

In edit mode, a stored beacon or working directory that is not in the live list
is still shown as an option, annotated (for example `my-beacon (offline)`), and
preselected. It is never silently rewritten.

### D11 — A shared `ProjectSelect` and a shared `useProjects()` hook

Both replace the duplicated dropdown and the duplicated list logic in both pages.

## Consequences

- The UI can now call `project.create` and `project.update`.
- The settings-panel sentinel navigates to the board page, so one modal lives in
  one place.
- `project.update` treats an empty `defaultWorkingDir` as "no change", so the
  modal cannot clear a working directory. The handler is unchanged.

## Does not amend

An earlier ADR. It extends ADR [271](271-drone-swarm-project-kanban-extension.md)
and follows ADR [274](274-card-modal-and-drone-ui-error-api.md).

## Out of scope

- Project delete.
- A per-automation beacon and working-directory override.
- Clearing a project default.
- A fix to `NewSessionPanel`, which has the same extension-node bug in its beacon
  list.
