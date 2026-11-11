---
key: plan-kanban-bundle-styling
tags:
  - plan
  - drone-swarm-project
  - kanban
  - front-end-bundle
  - drone-coordinator-ui
  - styling
  - css-tokens
  - ADR-277
created: 2026-11-11T19:25:47.249Z
updated: 2026-11-11T19:38:51.452Z
---

# Plan — Style the kanban bundle from the host's design tokens

**Status**: Ready for execution. Branch `feat/kanban-extension-base`.

**EXECUTED 2026-11-11** — all 14 steps done. LSP clean on every changed bundle
file (the only repo diagnostics are pre-existing Tailwind v4 `@plugin`/
`@custom-variant`/`@theme`/`@apply` warnings in the untouched
`drone-coordinator-ui/src/index.css`). `pnpm -r run build` / `pnpm typecheck` /
`pnpm run lint` exit 0; `pnpm test` 4714 passed / 19 skipped; bundle suite
`pnpm --filter drone-swarm-project test:ui` 25/25. `drone-swarm-project/src/**`
unchanged (D14 held). Files: `bundle/styles.css` (rewritten), new
`bundle/Button.tsx`, `ProjectSelect.tsx`, `BoardPage.tsx`, `BoardSettings.tsx`,
`ProjectModal.tsx`, `CardModal.tsx`, `QueueModal.tsx`, both test files. Docs:
ADR 277, `docs/adr/index.md` row, `docs/agents/drone-swarm-project.md` Styling
section, plus the Obsidian pointer stub / decisions index / module page / log /
meta. Note: multi-hunk `file__apply_diff` patches were parsed as one contiguous
hunk on this host — single-hunk patches per call worked reliably.
**Executor**: persona `code` for the code steps. Persona `test` for the test and
validation steps. One review pass at the end.
**Origin**: planning session, 2026-11-11.

## 1. Summary — what and why

`drone-swarm-project` is a swarm extension. It owns a kanban board. Its user
interface is a front-end bundle. The bundle is a separate esbuild build. It is
loaded by the coordinator UI as a same-origin ESM module.

The bundle ships its own stylesheet, `bundle/styles.css`. That stylesheet has
rules for cards, columns, modals, and fields. It has **no** rule for a button, a
dropdown, or a number input. So those controls use the raw browser style. They do
not match the host page.

The board page also has three defects:

- The header has no title. Other host pages have a title.
- The "No projects yet" message is small and at the top of the page. It must be
  large and centered both ways.
- The "New Project…" item in the project dropdown does nothing when the list is
  empty. It is the only item. A controlled `<select>` cannot fire a change event
  for the value it already shows.

The settings panel has a fourth defect:

- The two number inputs have no margin. They look cramped.

This plan makes the bundle use the host's **design tokens**. The host defines the
tokens as CSS custom properties on `:root` and on `.dark`. The bundle reads them
with `var(--…)`. The bundle does not import the host components. The bundle does
not use Tailwind utility classes. The bundle cannot do either of those things: it
is a separate build, and only React is shared with the host.

Result: the board follows the host theme in light mode and in dark mode.

## 2. Decisions (locked with the user)

| # | Decision |
|---|---|
| D1 | New styles go in `bundle/styles.css` as `dsp-*` classes. They use the host tokens (`--primary`, `--primary-foreground`, `--border`, `--input`, `--radius`, `--foreground`, `--muted-foreground`, `--card`, `--card-foreground`, `--muted`, `--ring`, `--background`). Every `var()` has a fallback value. No Tailwind classes. No import of the host `Button`. |
| D2 | The board page gains a title. The title is `<h1 className="dsp-title">`. It shows the selected project's name. It shows `Board` when no project is selected. The settings panel gains no title; the host already gives it a section `<h2>`. |
| D3 | `ProjectSelect` shows an inert `<option value="" disabled>No projects yet</option>` when the project list is empty. The option comes before the project options. The select then rests on that option. The `New Project…` option stays last and stays active. |
| D4 | The styled controls are: board header (`ProjectSelect`, `Edit Project`, `Queue`), the empty-hint `New Project` button, the settings panel (`ProjectSelect`, `Refresh`, `Delete`, `Add column`, the `New column` input), `ProjectModal` (`Close`, `Create`/`Save`, the Name input, the Beacon select, the Working-directory select), `CardModal` (`Close`, `Save`, the title input, the description textarea), and `QueueModal` (`Close`, `Retry`, `Cancel`). |
| D5 | The two number inputs in the settings Limits section get the existing `.dsp-field` class. A new rule keeps a number input inline and gives it margin: `.dsp-field input[type='number'] { display:inline-block; width:auto; margin:4px 0 4px 8px; }`. |
| D6 | The modal and the column/card greys use the host tokens. The modal is no longer a fixed white box. Result: the whole board follows light mode and dark mode. |
| D7 | The columns area gets `min-height: 240px`. A modifier class `dsp-columns-empty` centers its child. The modifier is applied only when the project list is empty. `.dsp-empty-hint` becomes `font-size: 1.25rem` and `color: var(--muted-foreground, #666)`. |
| D8 | Two button variants. `dsp-btn` is the outline style. It is used for every button. `dsp-btn-primary` is the filled style. It is used for the modal submit button only. The empty-hint `New Project` button uses the outline style. |
| D9 | The board header puts the title on the left and the controls on the right. The controls sit in a nested flex group. |
| D10 | The new classes are `dsp-btn`, `dsp-btn-primary`, `dsp-input`, `dsp-select`, `dsp-title`, `dsp-header-controls`, `dsp-column-actions`, `dsp-columns-empty`. |
| D11 | A small local `Button` component (`bundle/Button.tsx`) renders `<button>` with the `dsp-btn` classes. This avoids 15 copies of the class string. |
| D12 | Tests cover the two behaviors that can regress: the empty-list placeholder, and the conditional title. Tests do not assert CSS rules; jsdom does not apply the bundle stylesheet. |
| D13 | One new ADR, number **277** (276 is used). Plus a note in `docs/agents/drone-swarm-project.md`. The package README does not cover styling, so it does not change. |
| D14 | No server change. `drone-swarm-project/src/**` does not change. |

## 3. Order of work and dependencies

- Step 1 (the stylesheet) has no dependency. Do it first.
- Step 2 (the `Button` component) has no dependency. It is needed by steps 5 to 9.
- Step 3 and step 4 change shared components. Step 5 needs them.
- Steps 5 to 9 change the pages and the modals. They need steps 1 to 4.
- Steps 10 and 11 add tests. They need steps 1 to 9.
- Steps 12 and 13 write the documents. They need the code to be final.
- Step 14 is the validation.

Run the bundle build after step 1 and again after step 9:

```bash
pnpm --filter drone-swarm-project run build
```

---

## Step 1 — Rewrite the stylesheet [agent: code]

**File**: `drone-swarm-project/bundle/styles.css`

Replace the whole file. Keep the `dsp-` prefix. Keep the status pill colors: they
are semantic, and they read correctly in both modes.

```css
/* The bundle themes itself from the host's design tokens (drone-coordinator-ui
   defines them on :root and .dark). The bundle cannot import the host's
   components or Tailwind, so it reads the tokens with var() and falls back to
   the old literal values when a token is absent. */

.dsp-board,
.dsp-settings {
  font-family: system-ui, sans-serif;
  font-size: 13px;
  color: var(--foreground, inherit);
}

.dsp-board-header,
.dsp-settings-header {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}

.dsp-board-header {
  justify-content: space-between;
}

.dsp-header-controls {
  display: flex;
  gap: 8px;
  align-items: center;
}

.dsp-title {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 1.2;
  color: var(--foreground, inherit);
}

.dsp-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 4px 12px;
  font: inherit;
  font-weight: 500;
  line-height: 1.6;
  color: var(--foreground, #111);
  background: var(--background, #fff);
  border: 1px solid var(--border, rgba(127, 127, 127, 0.4));
  border-radius: var(--radius, 6px);
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.dsp-btn:hover:not(:disabled) {
  background: var(--muted, rgba(127, 127, 127, 0.12));
}

.dsp-btn:focus-visible {
  outline: 2px solid var(--ring, #2f6feb);
  outline-offset: 1px;
}

.dsp-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.dsp-btn-primary {
  color: var(--primary-foreground, #fff);
  background: var(--primary, #2f6feb);
  border-color: var(--primary, #2f6feb);
}

.dsp-btn-primary:hover:not(:disabled) {
  background: var(--primary, #2f6feb);
  filter: brightness(0.92);
}

.dsp-input,
.dsp-select {
  font: inherit;
  color: var(--foreground, #111);
  background: var(--background, #fff);
  border: 1px solid var(--input, rgba(127, 127, 127, 0.4));
  border-radius: var(--radius, 6px);
  padding: 4px 8px;
}

.dsp-input:focus-visible,
.dsp-select:focus-visible {
  outline: 2px solid var(--ring, #2f6feb);
  outline-offset: 1px;
}

.dsp-columns {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  overflow-x: auto;
  min-height: 240px;
}

.dsp-columns-empty {
  align-items: center;
  justify-content: center;
}

.dsp-column {
  flex: 0 0 220px;
  background: var(--muted, rgba(127, 127, 127, 0.08));
  border-radius: var(--radius, 6px);
  padding: 8px;
  min-height: 80px;
}

.dsp-column h3 {
  margin: 0 0 8px;
  font-size: 12px;
  text-transform: uppercase;
  color: var(--muted-foreground, inherit);
}

.dsp-card {
  background: var(--card, rgba(127, 127, 127, 0.14));
  color: var(--card-foreground, inherit);
  border: 1px solid var(--border, transparent);
  border-radius: var(--radius, 4px);
  padding: 6px 8px;
  margin-bottom: 6px;
  cursor: grab;
}

.dsp-card-title {
  margin-bottom: 4px;
}

.dsp-pill {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
  background: rgba(127, 127, 127, 0.25);
}

.dsp-pill-running {
  background: #2f6feb;
  color: #fff;
}

.dsp-pill-ended {
  background: #2f9e44;
  color: #fff;
}

.dsp-pill-failed {
  background: #e03131;
  color: #fff;
}

.dsp-pill-queued {
  background: #f08c00;
  color: #fff;
}

.dsp-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dsp-modal {
  background: var(--card, #fff);
  color: var(--card-foreground, #111);
  border: 1px solid var(--border, transparent);
  border-radius: var(--radius, 8px);
  padding: 16px;
  min-width: 420px;
  max-height: 80vh;
  overflow: auto;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
}

.dsp-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.dsp-queue-table {
  width: 100%;
  border-collapse: collapse;
}

.dsp-queue-table th,
.dsp-queue-table td {
  text-align: left;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border, rgba(127, 127, 127, 0.25));
}

.dsp-column-list {
  list-style: none;
  padding: 0;
}

.dsp-column-list li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 0;
}

.dsp-column-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}

.dsp-field {
  display: block;
  margin-bottom: 10px;
}

.dsp-field input,
.dsp-field select,
.dsp-field textarea {
  display: block;
  width: 100%;
  margin-top: 4px;
}

.dsp-field input[type='number'] {
  display: inline-block;
  width: auto;
  margin: 4px 0 4px 8px;
}

.dsp-field textarea {
  min-height: 80px;
}

.dsp-error {
  color: #e03131;
  margin: 4px 0;
}

.dsp-modal-actions {
  margin: 8px 0;
}

.dsp-card-meta dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 2px 12px;
  margin: 0;
}

.dsp-card-history ul {
  list-style: none;
  padding: 0;
  margin: 0;
}

.dsp-card-history li {
  padding: 2px 0;
  color: var(--muted-foreground, inherit);
}

.dsp-empty-hint {
  padding: 24px;
  text-align: center;
  font-size: 1.25rem;
  color: var(--muted-foreground, #666);
}

.dsp-empty-hint p {
  margin: 0 0 12px;
}
```

Note: the old rules `font: inherit` on `.dsp-field input` and `opacity: 0.8` on
the empty hint are removed. The new `.dsp-input`/`.dsp-select` rule supplies the
font, and the empty hint uses a token color.

## Step 2 — Add the local Button component [agent: code]

**New file**: `drone-swarm-project/bundle/Button.tsx`

The bundle shares React through `globalThis.React`. The global `JSX` namespace
comes from `bundle/globals.d.ts`. So this file imports no React runtime.

```tsx
type ButtonProps = JSX.IntrinsicElements['button'] & {
  /** `primary` is the filled style. The default is the outline style. */
  variant?: 'default' | 'primary';
};

/**
 * A button with the bundle's own style.
 *
 * The bundle cannot import the host's Button component, so it applies the shared
 * `dsp-btn` classes instead.
 */
export function Button({
  variant = 'default',
  className,
  ...rest
}: ButtonProps) {
  const base = variant === 'primary' ? 'dsp-btn dsp-btn-primary' : 'dsp-btn';
  return (
    <button
      className={className ? `${base} ${className}` : base}
      {...rest}
    />
  );
}
```

## Step 3 — Fix the project dropdown [agent: code]

**File**: `drone-swarm-project/bundle/ProjectSelect.tsx`

1. Add the inert placeholder option when the list is empty.
2. Apply the `dsp-select` class by default. Keep the `className` prop as an
   override.

```tsx
  return (
    <select
      className={className ? `dsp-select ${className}` : 'dsp-select'}
      value={value ?? ''}
      onChange={event => onSelect(event.target.value)}
    >
      {projects.length === 0 ? (
        <option value="" disabled>
          No projects yet
        </option>
      ) : null}
      {projects.map(item => (
        <option key={item.id} value={item.id}>
          {showCount ? `${item.name} (${item.cardCount})` : item.name}
        </option>
      ))}
      <option value={NEW_PROJECT_VALUE}>New Project…</option>
    </select>
  );
```

Add one sentence to the component's doc comment: the placeholder gives the
controlled select a value to rest on when the list is empty, so the sentinel
becomes selectable.

## Step 4 — Keep the hook unchanged [agent: code]

**File**: `drone-swarm-project/bundle/useProjects.ts`

No change. This step exists only to state that the selection rule
(`current ?? list[0]?.id`) is not touched.

## Step 5 — Update the board page [agent: code]

**File**: `drone-swarm-project/bundle/BoardPage.tsx`

1. Add the import:

```ts
import { Button } from './Button';
```

2. Replace the header. The title is the selected project's name. The name comes
   from the loaded list, so the title does not flicker.

```tsx
      <header className="dsp-board-header">
        <h1 className="dsp-title">
          {projects.find(item => item.id === selected)?.name ?? 'Board'}
        </h1>
        <div className="dsp-header-controls">
          <ProjectSelect
            projects={projects}
            value={selected}
            onChange={setSelected}
            onNewProject={() => setModal({ mode: 'create' })}
            showCount
          />
          <Button
            disabled={!selected || !project}
            onClick={() => setModal({ mode: 'edit' })}
          >
            Edit Project
          </Button>
          <Button onClick={() => setQueueOpen(true)}>Queue</Button>
        </div>
      </header>
```

3. Add the empty modifier to the columns container.

```tsx
      <div
        className={
          projects.length === 0 ? 'dsp-columns dsp-columns-empty' : 'dsp-columns'
        }
      >
        {projects.length === 0 ? (
          <div className="dsp-empty-hint">
            <p>No projects yet.</p>
            <Button onClick={() => setModal({ mode: 'create' })}>
              New Project
            </Button>
          </div>
        ) : null}
        {columns.map(column => (
          /* unchanged column markup */
        ))}
      </div>
```

## Step 6 — Update the settings panel [agent: code]

**File**: `drone-swarm-project/bundle/BoardSettings.tsx`

1. Add the import:

```ts
import { Button } from './Button';
```

2. Replace the header buttons:

```tsx
      <header className="dsp-settings-header">
        <ProjectSelect
          projects={projects}
          value={selected}
          onChange={setSelected}
          onNewProject={() => apiNavigate('/board')}
        />
        <Button onClick={refresh}>Refresh</Button>
      </header>
```

3. Use `Button` for `Delete`. Wrap the new-column input and the `Add column`
   button in a `.dsp-column-actions` group. Give the input the `dsp-input` class.

```tsx
          {columns.map(column => (
            <li key={column.id}>
              {column.name}
              <Button onClick={() => deleteColumn(column.id)}>Delete</Button>
            </li>
          ))}
        </ul>
        <div className="dsp-column-actions">
          <input
            className="dsp-input"
            placeholder="New column"
            value={newColumn}
            onChange={event => setNewColumn(event.target.value)}
          />
          <Button onClick={addColumn}>Add column</Button>
        </div>
```

4. Give the Limits labels the `.dsp-field` class. Give the number inputs the
   `dsp-input` class.

```tsx
            <label className="dsp-field">
              Max concurrent
              <input
                className="dsp-input"
                type="number"
                value={limits.maxConcurrentSessions}
                onChange={event =>
                  saveLimits({
                    maxConcurrentSessions: Number(event.target.value),
                  })
                }
              />
            </label>
            <label className="dsp-field">
              Max daily
              <input
                className="dsp-input"
                type="number"
                value={limits.maxDailySessions}
                onChange={event =>
                  saveLimits({ maxDailySessions: Number(event.target.value) })
                }
              />
            </label>
```

## Step 7 — Update the project modal [agent: code]

**File**: `drone-swarm-project/bundle/ProjectModal.tsx`

1. Add the import:

```ts
import { Button } from './Button';
```

2. Use `Button` for `Close`. Use `Button variant="primary"` for the submit.

```tsx
        <header className="dsp-modal-header">
          <h2>{title}</h2>
          <Button onClick={onClose}>Close</Button>
        </header>
```

```tsx
        <div className="dsp-modal-actions">
          <Button
            variant="primary"
            onClick={save}
            disabled={saving || !name.trim()}
          >
            {saving ? 'Saving…' : submitLabel}
          </Button>
        </div>
```

3. Give the Name input the `dsp-input` class. Give the two selects the
   `dsp-select` class.

```tsx
        <label className="dsp-field">
          Name
          <input
            className="dsp-input"
            value={name}
            onChange={event => setName(event.target.value)}
          />
        </label>

        <label className="dsp-field">
          Beacon
          <select
            className="dsp-select"
            value={beaconId}
            onChange={event => onBeaconChange(event.target.value)}
          >
            {/* unchanged options */}
          </select>
        </label>

        <label className="dsp-field">
          Working directory
          <select
            className="dsp-select"
            value={workingDir}
            onChange={event => setWorkingDir(event.target.value)}
          >
            {/* unchanged options */}
          </select>
        </label>
```

## Step 8 — Update the card modal [agent: code]

**File**: `drone-swarm-project/bundle/CardModal.tsx`

1. Add the import:

```ts
import { Button } from './Button';
```

2. Use `Button` for `Close`. Use `Button variant="primary"` for `Save`. Give the
   title input and the description textarea the `dsp-input` class.

```tsx
        <header className="dsp-modal-header">
          <h2>Card</h2>
          <Button onClick={onClose}>Close</Button>
        </header>

        <label className="dsp-field">
          Title
          <input
            className="dsp-input"
            value={title}
            onChange={event => setTitle(event.target.value)}
          />
        </label>

        <label className="dsp-field">
          Description
          <textarea
            className="dsp-input"
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>

        {/* error line unchanged */}

        <div className="dsp-modal-actions">
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
```

## Step 9 — Update the queue modal [agent: code]

**File**: `drone-swarm-project/bundle/QueueModal.tsx`

1. Add the import:

```ts
import { Button } from './Button';
```

2. Use `Button` for `Close`, `Retry`, and `Cancel`.

```tsx
        <header className="dsp-modal-header">
          <h2>Queue</h2>
          <Button onClick={props.onClose}>Close</Button>
        </header>
```

```tsx
                <td>
                  {job.state === 'failed' ? (
                    <Button onClick={() => retry(job.id)}>Retry</Button>
                  ) : null}
                  {job.state === 'queued' ? (
                    <Button onClick={() => cancel(job.id)}>Cancel</Button>
                  ) : null}
                </td>
```

Run the bundle build after this step:

```bash
pnpm --filter drone-swarm-project run build
```

## Step 10 — Extend the select test [agent: test]

**File**: `drone-swarm-project/bundle/ProjectSelect.test.tsx`

Keep the three existing cases. Add two cases.

```tsx
  it('shows an inert placeholder when there are no projects', () => {
    render(
      <ProjectSelect
        projects={[]}
        value={undefined}
        onChange={() => {}}
        onNewProject={() => {}}
      />
    );
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('No projects yet');
    expect(options[0]).toBeDisabled();
    expect(options[options.length - 1]).toHaveTextContent('New Project…');
  });

  it('opens the modal from the sentinel when there are no projects', async () => {
    const user = userEvent.setup();
    const onNewProject = vi.fn();
    render(
      <ProjectSelect
        projects={[]}
        value={undefined}
        onChange={() => {}}
        onNewProject={onNewProject}
      />
    );
    await user.selectOptions(screen.getByRole('combobox'), '__new_project__');
    expect(onNewProject).toHaveBeenCalledTimes(1);
  });
```

## Step 11 — Extend the board test [agent: test]

**File**: `drone-swarm-project/bundle/BoardPage.test.tsx`

Keep the five existing cases. Add three cases.

```tsx
  it('centers the columns area when there are no projects', async () => {
    installApi([]);
    render(<BoardPage />);
    const hint = (await screen.findByText('No projects yet.')).closest(
      '.dsp-columns'
    );
    expect(hint).toHaveClass('dsp-columns-empty');
  });

  it('shows the selected project name as the title', async () => {
    installApi();
    render(<BoardPage />);
    expect(
      await screen.findByRole('heading', { name: 'Alpha' })
    ).toBeInTheDocument();
  });

  it('falls back to the Board title with no projects', async () => {
    installApi([]);
    render(<BoardPage />);
    expect(
      await screen.findByRole('heading', { name: 'Board' })
    ).toBeInTheDocument();
  });
```

Note: the empty-hint paragraph reads `No projects yet.` (with a period). The
placeholder option reads `No projects yet` (no period). So `findByText` matches
only the paragraph.

## Step 12 — Write the documents [agent: code]

1. **New ADR**: `docs/adr/277-kanban-bundle-host-theme-tokens.md`.

   Use the same shape as ADR 275. Frontmatter `tags`:
   `[decision, drone-swarm-project, drone-coordinator-ui, swarm-extension, front-end-bundle, kanban, styling, design-tokens]`.
   Frontmatter `related`: `[271-drone-swarm-project-kanban-extension.md, 274-card-modal-and-drone-ui-error-api.md, 275-kanban-project-create-and-edit-ui.md, modules/drone-swarm-project.md, modules/drone-coordinator-ui.md]`.

   Content:
   - **Status**: Implemented (date, branch).
   - **Context.** The bundle is a separate esbuild build. It shares only React
     with the host. It cannot import the host components and cannot use Tailwind.
     Its stylesheet had no rule for a button, a dropdown, or a number input, so
     those controls used the raw browser style. The board header had no title.
     The "No projects yet" state was small and top-aligned. The `New Project…`
     sentinel did nothing when it was the only option, because a controlled
     `<select>` cannot fire a change event for the value it already shows. The
     modal was a fixed white box, so it did not follow dark mode.
   - **Decision.**
     - **D1** the bundle styles itself with `dsp-*` classes that read the host's
       CSS custom properties, each with a fallback; no Tailwind, no host
       component imports.
     - **D2** the board page gains a conditional `<h1>`: the selected project's
       name, fallback `Board`; the settings panel gains none (the host supplies
       its section heading).
     - **D3** `ProjectSelect` renders an inert disabled `No projects yet` option
       when the list is empty, so the `New Project…` sentinel becomes selectable.
     - **D4** two button variants: `dsp-btn` (outline, all buttons) and
       `dsp-btn-primary` (filled, modal submit only).
     - **D5** one local `Button` component applies the classes, so the class
       string is not repeated per call site.
     - **D6** the modal and the column/card greys use tokens, so the board
       follows light and dark mode.
     - **D7** the empty state is centered by a `dsp-columns-empty` modifier on
       the columns container, with a larger hint.
     - **D8** the settings number inputs reuse `.dsp-field` and stay inline.
   - **Consequences.** The board matches the host theme in both modes. A future
     bundle author must follow the same rule: tokens, not Tailwind, not host
     components. The fallback values keep the bundle readable when the host
     tokens are absent (a test, a preview).
   - **Does not amend** an earlier ADR. It extends ADR 271 and follows ADRs 274
     and 275.
   - **Out of scope.** No change to the board data, the capabilities, or the
     store.

2. **Index row**: add one row for 277 at the top of `docs/adr/index.md`.

   **Known pre-existing defect.** The index has duplicate rows and missing rows.
   It is tracked as project memory `followup-adr-index-duplicate-rows-and-missing-entries`.
   Do not repair the index in this plan. Add the one 277 row.

3. **Agent doc**: in `docs/agents/drone-swarm-project.md`, add a "Styling"
   section after the "Project create and edit" section. State: the bundle themes
   itself with `dsp-*` classes that read the host design tokens
   (`var(--primary)`, `var(--border)`, and so on) with fallbacks; it cannot
   import the host components or Tailwind, because it is a separate esbuild build
   and only React is shared; a shared local `Button` component applies the button
   classes. Reference ADR 277.

4. **Obsidian wiki** (vault at `/home/unleet/Obsidian/drone-agent-project`):
   - Add a pointer stub `decisions/277-kanban-bundle-host-theme-tokens.md`, with
     the same shape as `decisions/275-kanban-project-create-and-edit-ui.md`.
   - Add the 277 row to `decisions/index.md`.
   - In `modules/drone-swarm-project.md`, add a note about the token-based
     styling.
   - Append an entry to `log.md`. Update `meta.json`.

## Step 13 — Commit the memory [agent: code]

Store the project memory for this plan. Commit the memory, the ADR, and the doc
changes on the branch `feat/kanban-extension-base`. Do not commit to `main`.

## Step 14 — Check the work against the validation criteria [agent: test]

Run every command in section 4. Do not mark the work done until all pass.

---

## 4. Validation criteria

All of these must pass.

1. **LSP** — no errors and no warnings on every changed file:
   `bundle/styles.css`, `bundle/Button.tsx`, `bundle/ProjectSelect.tsx`,
   `bundle/BoardPage.tsx`, `bundle/BoardSettings.tsx`,
   `bundle/ProjectModal.tsx`, `bundle/CardModal.tsx`, `bundle/QueueModal.tsx`,
   and the two test files.
2. **Build** — `pnpm -r run build` exits 0. This compiles the bundle with
   esbuild.
3. **Typecheck** — `pnpm typecheck` exits 0. This includes the bundle's two
   tsconfigs.
4. **Lint** — `pnpm run lint` exits 0 (eslint, then prettier). Prettier
   reformats files. Re-read every file before a later edit.
5. **Fast test suite** — `pnpm test` passes.
6. **Bundle tests** — `pnpm --filter drone-swarm-project test:ui` passes.
7. **Behavior** — the new tests cover these points:
   - The empty-list dropdown shows the disabled `No projects yet` placeholder
     first, and `New Project…` last.
   - A pick of `New Project…` calls `onNewProject` when the list is empty.
   - The columns area carries `dsp-columns-empty` when the list is empty.
   - The title is the selected project's name, and `Board` when there is none.
8. **No server change** — `drone-swarm-project/src/**` is unchanged.
   `pnpm --filter drone-swarm-project test` stays green.
9. **Docs** — ADR 277 exists, the index row is present, and the agent doc has the
   "Styling" section.
10. **Memory committed** — the project memory, the ADR, and the doc changes are
    committed on `feat/kanban-extension-base`, not `main`.

## 5. Out of scope

- A change to the board data model, the capabilities, or the store.
- A Tailwind setup for the bundle.
- A shared theme module between the bundle and the host.
- A repair of the `docs/adr/index.md` duplicates. It is a separate followup.
- The `NewSessionPanel` extension-node bug. It is a separate followup.
