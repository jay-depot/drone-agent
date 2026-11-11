---
tags:
  [
    decision,
    drone-swarm-project,
    drone-coordinator-ui,
    swarm-extension,
    front-end-bundle,
    kanban,
    styling,
    design-tokens,
  ]
related:
  [
    271-drone-swarm-project-kanban-extension.md,
    274-card-modal-and-drone-ui-error-api.md,
    275-kanban-project-create-and-edit-ui.md,
    modules/drone-swarm-project.md,
    modules/drone-coordinator-ui.md,
  ]
---

# ADR 277: Style the kanban bundle from the host's design tokens

**Status**: Implemented (2026-11-11, branch `feat/kanban-extension-base`)

## Context

The `drone-swarm-project` board bundle is a separate esbuild build. It shares
only React with the host (`drone-coordinator-ui`). It cannot import the host
components, and it cannot use Tailwind utility classes.

Its stylesheet, `bundle/styles.css`, had rules for cards, columns, modals, and
fields. It had **no** rule for a button, a dropdown, or a number input. So those
controls used the raw browser style and did not match the host page.

The board page also had three defects:

- The header had no title. Other host pages have a title.
- The "No projects yet" message was small and at the top of the page. It must be
  large and centered both ways.
- The `New Project…` item in the project dropdown did nothing when the list was
  empty. It was the only item. A controlled `<select>` cannot fire a change
  event for the value it already shows.

The settings panel had a fourth defect: the two number inputs had no margin.

The host defines its design tokens as CSS custom properties on `:root` and on
`.dark`.

## Decision

- **D1** — The bundle styles itself with `dsp-*` classes that read the host's
  CSS custom properties (`--primary`, `--primary-foreground`, `--border`,
  `--input`, `--radius`, `--foreground`, `--muted-foreground`, `--card`,
  `--card-foreground`, `--muted`, `--ring`, `--background`), each with a
  fallback value. No Tailwind classes. No import of the host `Button`.
- **D2** — The board page gains a conditional `<h1 className="dsp-title">`: the
  selected project's name, fallback `Board`. The settings panel gains none; the
  host already supplies its section heading.
- **D3** — `ProjectSelect` renders an inert disabled `No projects yet` option
  when the list is empty, so the `New Project…` sentinel becomes selectable. The
  placeholder comes before the project options; the sentinel stays last and
  stays active.
- **D4** — Two button variants: `dsp-btn` (outline, every button) and
  `dsp-btn-primary` (filled, the modal submit button only). The empty-hint `New
Project` button uses the outline style.
- **D5** — One local `Button` component (`bundle/Button.tsx`) applies the button
  classes, so the class string is not repeated per call site.
- **D6** — The modal and the column/card greys use the host tokens, so the whole
  board follows light mode and dark mode.
- **D7** — The columns area gains `min-height: 240px`. A `dsp-columns-empty`
  modifier centers its child. The empty-hint text is `1.25rem` in
  `var(--muted-foreground)`.
- **D8** — The settings number inputs reuse `.dsp-field` and stay inline, with a
  new `.dsp-field input[type='number']` rule for margin.

## Consequences

- The board matches the host theme in both modes.
- A future bundle author must follow the same rule: tokens, not Tailwind, not
  host components.
- The fallback values keep the bundle readable when the host tokens are absent
  (a test, a preview).
- Tests cover behavior only. jsdom does not apply the bundle stylesheet, so the
  tests assert the empty-list placeholder and the conditional title, not CSS
  rules.

## Does not amend

An earlier ADR. It extends ADR [271](271-drone-swarm-project-kanban-extension.md)
and follows ADRs [274](274-card-modal-and-drone-ui-error-api.md) and
[275](275-kanban-project-create-and-edit-ui.md).

## Out of scope

- A change to the board data model, the capabilities, or the store.
- A Tailwind setup for the bundle.
- A shared theme module between the bundle and the host.
