---
key: plan-kanban-add-card-ui
tags:
  - plan
  - drone-swarm-project
  - drone-coordinator-ui
  - swarm-extension
  - front-end-bundle
  - kanban
  - card-create
  - modal-shell
  - button-variant
  - ADR-278
created: 2026-11-13T19:12:50.321Z
updated: 2026-11-13T19:22:58.086Z
---

# Plan — Add a card from the board: an "Add card" button per column and a new-card modal

**Status**: Ready for execution. Branch `feat/kanban-addon-card-ui`.
**Status**: EXECUTED (2026-11-13). Branch `feat/kanban-addon-card-ui`. Commit `7b11368b`.
All 11 steps done; every validation criterion passed. See "Execution summary" at the end.
**Executor**: persona `code`. Tests by persona `code` (test steps are marked). One review pass before
validation.
**Package**: `drone-swarm-project` — the kanban swarm extension. Front-end bundle only.

## 1. Summary — what and why

The kanban board shows columns and cards. A user can move a card between columns and edit a card.
The user **cannot create a card from the web UI**. The `card.create` capability already exists. It is
`mcp`-tier. The web UI can call it. No UI code calls it.

This plan adds:

- an **"Add card" button at the bottom of every column**;
- a **"New card" modal** with a Title field and a Description field;
- a **shared `Modal` shell**, used by the new modal and by the three existing modals.

**No server change is needed.** `card.create` already accepts `projectId`, `title`, `description`,
and `columnId`. The handler already sets `actor: 'user'` when the caller is the UI.

## 2. Decisions (locked with the user)

- **D1 — No server change.** `drone-swarm-project/src/**` is not touched.
- **D2 — Shared `Modal` shell.** New file `bundle/Modal.tsx`. Contract:
  `<Modal title={string} onClose={fn}>{children}</Modal>`. The shell owns the backdrop, the panel,
  the header (an `<h2>` with the title and a Close button), and the Escape listener. The children
  are the body only. `ProjectModal`, `CardModal`, and `QueueModal` move to the shell. The rendered
  DOM does not change, so their tests do not change.
- **D3 — New `CardCreateModal`.** It has a Title field and a Description field. Both go to
  `card.create`.
- **D4 — The target column is fixed.** The column is the column whose button was clicked. The modal
  shows the column name as read-only text. There is no column picker.
- **D5 — After a create.** The modal closes, the board reloads, and the project list reloads. The
  project list reloads because the dropdown shows a card count.
- **D6 — Button style.** The button is a ghost button. It is full width. It is always visible. The
  label is `+ Add card`.
- **D7 — A third button variant.** `bundle/Button.tsx` gains `variant="ghost"`. `styles.css` gains a
  `dsp-btn-ghost` class.
- **D8 — Focus.** The Title input is focused when the modal opens (`autoFocus`).
- **D9 — Accessible name.** Each button has `aria-label={'Add card to ' + column.name}`.
- **D10 — Board state.** `BoardPage` holds `{ columnId, columnName } | undefined`. It is a snapshot.
  The modal needs no `project` prop. The 3-second poll cannot blank the name.
- **D11 — Automations fire.** `card.create` already calls
  `enqueueForMove(project, card, null, card.columnId)`. So a wildcard-from automation
  (`* → <column>`) matches, and a job is enqueued. This is **accepted**. The ADR and the agent doc
  must state it.
- **D12 — Errors.** A failure shows an inline error and calls `uiErrors().show(...)`. The modal stays
  open. The submit button is disabled when the title is empty and when a create is in progress. The
  submit button is `variant="primary"`.
- **D13 — Tests.** New `bundle/Modal.test.tsx` and `bundle/CardCreateModal.test.tsx`.
  `bundle/BoardPage.test.tsx` gains cases. The existing modal tests do not change.
- **D14 — Docs.** New ADR 278 and its index row, a section in `docs/agents/drone-swarm-project.md`,
  a README bullet, and an Obsidian wiki stub.

## 3. Files

- **New:** `bundle/Modal.tsx`, `bundle/CardCreateModal.tsx`, `bundle/Modal.test.tsx`,
  `bundle/CardCreateModal.test.tsx`, `docs/adr/278-kanban-add-card-ui.md`
- **Changed:** `bundle/Button.tsx`, `bundle/styles.css`, `bundle/BoardPage.tsx`,
  `bundle/CardModal.tsx`, `bundle/ProjectModal.tsx`, `bundle/QueueModal.tsx`,
  `bundle/BoardPage.test.tsx`, `docs/agents/drone-swarm-project.md`,
  `drone-swarm-project/README.md`
- **Untouched:** all of `drone-swarm-project/src/`

## 4. Order of work and dependencies

- Step 1 (the shell) comes first. Steps 3 and 4 need it.
- Step 2 (the ghost variant) is independent. Step 5 needs it.
- Step 3 (the new modal) needs Step 1.
- Step 4 (migrate the three modals) needs Step 1. Do it before Step 5, so the review pass sees one
  shape.
- Step 5 (the board) needs Steps 2 and 3.
- Steps 6, 7, and 8 are tests. They need Steps 1 to 5.
- Step 9 is docs. It needs the code to be final.
- Step 10 is the review pass. Step 11 is validation.

Build gate after Step 5:

```bash
pnpm --filter drone-swarm-project run build
```

---

## Step 1 — Add the shared Modal shell [agent: code]

**New file**: `drone-swarm-project/bundle/Modal.tsx`

The shell replaces the same markup in three modals. It owns the backdrop, the panel, the header, and
the Escape listener.

```tsx
import type { ReactNode } from 'react';
import { Button } from './Button';

export interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * The shared modal shell.
 *
 * It owns the backdrop, the panel, the header (title and Close), and the
 * Escape listener. The children are the body only. A click on the backdrop
 * closes the modal; a click on the panel does not.
 */
export function Modal({ title, onClose, children }: ModalProps) {
  const React = globalThis.React;

  React.useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dsp-modal-backdrop" onClick={onClose}>
      <div className="dsp-modal" onClick={event => event.stopPropagation()}>
        <header className="dsp-modal-header">
          <h2>{title}</h2>
          <Button onClick={onClose}>Close</Button>
        </header>
        {children}
      </div>
    </div>
  );
}
```

**Note for the executor.** `import type { ReactNode } from 'react'` is a type-only import. The
bundle never imports React as a value (React arrives on `globalThis.React`). A type-only import is
correct here. `bundle/globals.d.ts` already imports react types in the same way.

## Step 2 — Add the ghost button variant [agent: code]

**File**: `drone-swarm-project/bundle/Button.tsx`

Add a third variant.

```tsx
type ButtonProps = JSX.IntrinsicElements['button'] & {
  /** `primary` is filled. `ghost` is low emphasis. The default is outline. */
  variant?: 'default' | 'primary' | 'ghost';
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
  const base =
    variant === 'primary'
      ? 'dsp-btn dsp-btn-primary'
      : variant === 'ghost'
        ? 'dsp-btn dsp-btn-ghost'
        : 'dsp-btn';
  return (
    <button className={className ? `${base} ${className}` : base} {...rest} />
  );
}
```

**File**: `drone-swarm-project/bundle/styles.css`

Add these rules. Put them after the `.dsp-btn-primary` rules.

```css
.dsp-btn-ghost {
  color: var(--muted-foreground, inherit);
  background: transparent;
  border-color: transparent;
}

.dsp-btn-ghost:hover:not(:disabled) {
  color: var(--foreground, inherit);
  background: var(--muted, rgba(127, 127, 127, 0.12));
}

.dsp-add-card {
  display: flex;
  width: 100%;
  margin-top: 2px;
}

.dsp-muted {
  margin: 0 0 10px;
  color: var(--muted-foreground, inherit);
}
```

`.dsp-add-card` comes after `.dsp-btn` in the file, so its `display` and `width` win. The
`.dsp-muted` rule is used by Step 3.

## Step 3 — Add the new-card modal [agent: code]

**New file**: `drone-swarm-project/bundle/CardCreateModal.tsx`

```tsx
import type { ActionReply, Card } from './types';
import { action, uiErrors } from './api';
import { Modal } from './Modal';
import { Button } from './Button';

export interface CardCreateModalProps {
  projectId: string;
  columnId: string;
  columnName: string;
  onClose: () => void;
  onCreated: (card: Card) => void;
}

/**
 * The new-card modal.
 *
 * The target column is fixed: it is the column whose "Add card" button opened
 * this modal. The column name is read-only text. There is no column picker.
 */
export function CardCreateModal(props: CardCreateModalProps) {
  const React = globalThis.React;
  const { projectId, columnId, columnName, onClose, onCreated } = props;
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);

  function create(): void {
    const trimmed = title.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(undefined);
    void action<ActionReply<{ card: Card }>>('card.create', {
      projectId,
      columnId,
      title: trimmed,
      description,
    })
      .then(reply => {
        const created = reply.body?.card;
        if (!reply.ok || !created) {
          const body = reply.body as { error?: string } | undefined;
          const message = body?.error ?? `Create failed (HTTP ${reply.status})`;
          setError(message);
          uiErrors().show(message);
          return;
        }
        onCreated(created);
      })
      .catch((err: unknown) => setError(uiErrors().fromThrown(err)))
      .finally(() => setSaving(false));
  }

  return (
    <Modal title="New card" onClose={onClose}>
      <p className="dsp-muted">Column: {columnName}</p>

      <label className="dsp-field">
        Title
        <input
          className="dsp-input"
          autoFocus
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

      {error ? <p className="dsp-error">{error}</p> : null}

      <div className="dsp-modal-actions">
        <Button
          variant="primary"
          onClick={create}
          disabled={saving || !title.trim()}
        >
          {saving ? 'Saving…' : 'Create'}
        </Button>
      </div>
    </Modal>
  );
}
```

## Step 4 — Move the three existing modals to the shell [agent: code]

For each file: delete the Escape `React.useEffect`, delete the `dsp-modal-backdrop` and
`dsp-modal` wrapper `div`s, delete the `header.dsp-modal-header` block, and wrap the body in
`<Modal>`.

**File**: `drone-swarm-project/bundle/CardModal.tsx`

Replace the return statement. The body is unchanged.

```tsx
  return (
    <Modal title="Card" onClose={onClose}>
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

      {error ? <p className="dsp-error">{error}</p> : null}

      <div className="dsp-modal-actions">
        <Button variant="primary" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      <section className="dsp-card-meta">
        <h3>Details</h3>
        <dl>
          <dt>Status</dt>
          <dd>{card.sessionStatus ?? 'idle'}</dd>
          <dt>Column</dt>
          <dd>{columnName(project, card.columnId)}</dd>
          <dt>Session</dt>
          <dd>{card.sessionId ?? 'none'}</dd>
        </dl>
      </section>

      <section className="dsp-card-history">
        <h3>History</h3>
        {history.length === 0 ? (
          <p>No moves recorded.</p>
        ) : (
          <ul>
            {[...history].reverse().map((record, index) => (
              <li key={index}>{historyLine(project, record)}</li>
            ))}
          </ul>
        )}
      </section>
    </Modal>
  );
```

Add `import { Modal } from './Modal';`. Remove the Escape effect. Keep the `Button` import.

**File**: `drone-swarm-project/bundle/ProjectModal.tsx`

Delete the Escape effect. Replace the return statement.

```tsx
  const title = mode === 'edit' ? 'Edit Project' : 'New Project';
  const submitLabel = mode === 'edit' ? 'Save' : 'Create';

  return (
    <Modal title={title} onClose={onClose}>
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
          <option value={NONE}>None</option>
          {beaconOptions.map(beacon => (
            <option key={beacon.id} value={beacon.id}>
              {beacon.name}
            </option>
          ))}
        </select>
      </label>

      <label className="dsp-field">
        Working directory
        <select
          className="dsp-select"
          value={workingDir}
          onChange={event => setWorkingDir(event.target.value)}
        >
          <option value={NONE}>None</option>
          {rootOptions.map(root => (
            <option key={root} value={root}>
              {root}
            </option>
          ))}
        </select>
      </label>

      {error ? <p className="dsp-error">{error}</p> : null}

      <div className="dsp-modal-actions">
        <Button
          variant="primary"
          onClick={save}
          disabled={saving || !name.trim()}
        >
          {saving ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </Modal>
  );
```

Add `import { Modal } from './Modal';`.

**File**: `drone-swarm-project/bundle/QueueModal.tsx`

Replace the return statement.

```tsx
  return (
    <Modal title="Queue" onClose={props.onClose}>
      <table className="dsp-queue-table">
        <thead>
          <tr>
            <th>State</th>
            <th>Card</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {jobs.map(job => (
            <tr key={job.id}>
              <td>
                <span className={`dsp-pill dsp-pill-${job.state}`}>
                  {job.state}
                </span>
              </td>
              <td>{job.cardId}</td>
              <td>{new Date(job.createdAt).toLocaleString()}</td>
              <td>
                {job.state === 'failed' ? (
                  <Button onClick={() => retry(job.id)}>Retry</Button>
                ) : null}
                {job.state === 'queued' ? (
                  <Button onClick={() => cancel(job.id)}>Cancel</Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
```

Add `import { Modal } from './Modal';`. Keep the `Button` import.

## Step 5 — Add the button and the modal to the board page [agent: code]

**File**: `drone-swarm-project/bundle/BoardPage.tsx`

1. Add the import:

```ts
import { CardCreateModal } from './CardCreateModal';
```

2. Add the modal state, next to the other state:

```ts
  const [newCard, setNewCard] = React.useState<
    { columnId: string; columnName: string } | undefined
  >(undefined);
```

3. Add the button at the end of each column, after the card list. The column markup becomes:

```tsx
          <div
            key={column.id}
            className="dsp-column"
            onDragOver={event => event.preventDefault()}
            onDrop={() => onDrop(column.id)}
          >
            <h3>{column.name}</h3>
            {(project?.cards ?? [])
              .filter(card => card.columnId === column.id)
              .sort((a, b) => a.position - b.position)
              .map(card => (
                <div
                  key={card.id}
                  className="dsp-card"
                  draggable
                  onDragStart={() => {
                    didDrag.current = true;
                    dragCard.current = card.id;
                  }}
                  onDragEnd={() => {
                    setTimeout(() => {
                      didDrag.current = false;
                    }, 0);
                  }}
                  onClick={() => {
                    if (didDrag.current) return;
                    setOpenCardId(card.id);
                  }}
                >
                  <div className="dsp-card-title">{card.title}</div>
                  <span className={statusClass(card)}>
                    {card.sessionStatus ?? 'idle'}
                  </span>
                </div>
              ))}
            <Button
              variant="ghost"
              className="dsp-add-card"
              aria-label={`Add card to ${column.name}`}
              onClick={() =>
                setNewCard({ columnId: column.id, columnName: column.name })
              }
            >
              + Add card
            </Button>
          </div>
```

4. Render the modal, next to the `CardModal` block:

```tsx
      {newCard && selected ? (
        <CardCreateModal
          projectId={selected}
          columnId={newCard.columnId}
          columnName={newCard.columnName}
          onClose={() => setNewCard(undefined)}
          onCreated={() => {
            setNewCard(undefined);
            void loadBoard(selected);
            void reload();
          }}
        />
      ) : null}
```

`reload` comes from `useProjects()`. It is already destructured in `BoardPage`.

**Note for the executor.** The new card goes to the end of the column. The store pushes the card and
re-indexes the positions. No position parameter is sent.

**Note for the executor.** `CardCreateModal` uses a React fragment? No. It has one root. Good.

## Step 6 — Add the shell test [agent: test]

**New file**: `drone-swarm-project/bundle/Modal.test.tsx`

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders the title and the children', () => {
    render(
      <Modal title="Thing" onClose={() => {}}>
        <p>Body</p>
      </Modal>
    );
    expect(screen.getByRole('heading', { name: 'Thing' })).toBeInTheDocument();
    expect(screen.getByText('Body')).toBeInTheDocument();
  });

  it('calls onClose on Escape', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal title="Thing" onClose={onClose}>
        <p>Body</p>
      </Modal>
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on a backdrop click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <Modal title="Thing" onClose={onClose}>
        <p>Body</p>
      </Modal>
    );
    await user.click(container.querySelector('.dsp-modal-backdrop')!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose on a panel click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal title="Thing" onClose={onClose}>
        <p>Body</p>
      </Modal>
    );
    await user.click(screen.getByText('Body'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

## Step 7 — Add the new-card modal test [agent: test]

**New file**: `drone-swarm-project/bundle/CardCreateModal.test.tsx`

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CardCreateModal } from './CardCreateModal';
import { setApi } from './api';

function installApi(reply: unknown) {
  const fetchImpl = vi.fn(async (_path: string, _init?: RequestInit) => ({
    ok: true,
    json: async () => reply,
  }));
  setApi({
    registerComponent: () => () => {},
    registerRoute: () => () => {},
    fetch: fetchImpl as unknown as typeof fetch,
    navigate: () => {},
    ui: {
      errors: {
        show: vi.fn(),
        fromResponse: vi.fn(async () => 'x'),
        fromThrown: vi.fn(() => 'thrown'),
      },
    },
  });
  return fetchImpl;
}

const props = {
  projectId: 'p_1',
  columnId: 'col_todo',
  columnName: 'Todo',
  onClose: () => {},
};

describe('CardCreateModal', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('starts empty and shows the fixed column', () => {
    installApi({ ok: true, body: {} });
    render(<CardCreateModal {...props} />);
    expect(screen.getByText('Column: Todo')).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toHaveValue('');
    expect(screen.getByLabelText('Description')).toHaveValue('');
  });

  it('disables Create while the title is empty', () => {
    installApi({ ok: true, body: {} });
    render(<CardCreateModal {...props} />);
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
  });

  it('sends card.create with the column and the fields', async () => {
    const user = userEvent.setup();
    const fetchImpl = installApi({ ok: true, body: { card: { id: 'c_9' } } });
    const onCreated = vi.fn();
    render(<CardCreateModal {...props} onCreated={onCreated} />);
    await user.type(screen.getByLabelText('Title'), 'New thing');
    await user.type(screen.getByLabelText('Description'), 'Details');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const call = fetchImpl.mock.calls.find(call =>
      String(call[0]).includes('card.create')
    );
    const sent = JSON.parse(String((call![1] as RequestInit).body));
    expect(sent.params.projectId).toBe('p_1');
    expect(sent.params.columnId).toBe('col_todo');
    expect(sent.params.title).toBe('New thing');
    expect(sent.params.description).toBe('Details');
  });

  it('shows an inline error and stays open on failure', async () => {
    const user = userEvent.setup();
    installApi({ ok: false, status: 400, body: { error: 'bad card' } });
    const onCreated = vi.fn();
    render(<CardCreateModal {...props} onCreated={onCreated} />);
    await user.type(screen.getByLabelText('Title'), 'X');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('bad card')).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    installApi({ ok: true, body: {} });
    const onClose = vi.fn();
    render(<CardCreateModal {...props} onClose={onClose} />);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

**Note for the executor.** The action endpoint is `POST
/api/extensions/<nodeId>/actions/<name>`. A mock that matches `path.includes('/api/extensions')`
catches **every** action call. Match on `path.endsWith(...)` or on the action name. The mock above
returns one reply for all paths, so it is safe.

## Step 8 — Extend the board-page test [agent: test]

**File**: `drone-swarm-project/bundle/BoardPage.test.tsx`

Add these cases. Keep the existing cases.

```tsx
  it('renders one Add card button per column with a column label', async () => {
    installApi();
    render(<BoardPage />);
    const button = await screen.findByRole('button', {
      name: 'Add card to Todo',
    });
    expect(button).toBeInTheDocument();
  });

  it('opens the new-card modal from the column button', async () => {
    const user = userEvent.setup();
    installApi();
    render(<BoardPage />);
    await user.click(
      await screen.findByRole('button', { name: 'Add card to Todo' })
    );
    expect(
      await screen.findByRole('heading', { name: 'New card' })
    ).toBeInTheDocument();
  });
```

The `installApi` mock needs no change. The board test never submits the modal, so it never calls
`card.create`.

## Step 9 — Documentation [agent: code]

1. **New ADR**: `docs/adr/278-kanban-add-card-ui.md`.

   Content:
   - **Context.** The board bundle can move and edit cards (ADR 274) and create and edit projects
     (ADR 275). It cannot create a card. The `card.create` capability exists. It is `mcp`-tier. The
     web UI can call it. No UI code calls it. Three modals each repeated the same shell markup.
   - **Decision.**
     - **D1** an "Add card" button sits at the bottom of every column. It opens a new-card modal.
     - **D2** the target column is the column whose button was clicked. The column name is
       read-only text. There is no column picker.
     - **D3** the modal has a Title field and a Description field. Both go to `card.create`.
     - **D4** on success the modal closes, the board reloads, and the project list reloads.
     - **D5** a shared `Modal` shell owns the backdrop, the panel, the header, and the Escape
       listener. `ProjectModal`, `CardModal`, and `QueueModal` use it. The rendered DOM does not
       change.
     - **D6** `Button` gains a third variant, `ghost`, for the low-emphasis add-card button.
     - **D7** the Title input is focused on open.
     - **D8** each button has a unique accessible name, `Add card to <column name>`.
     - **D9** a create can fire an automation. `card.create` already enqueues for a wildcard-from
       rule (`* → <column>`). This is accepted: card creation is an arrival in the column.
   - **Consequences.** The UI can call `card.create`. A card created by the UI records
     `actor: 'user'`. The shell is a shared primitive with four consumers.
   - **Does not amend** an earlier ADR. It extends ADR 271 and follows ADRs 274 and 277.

2. **Index row**: add a row for 278 to `docs/adr/index.md`.

   **Known pre-existing defect.** The index has duplicate rows and missing rows. It is tracked as
   project memory `followup-adr-index-duplicate-rows-and-missing-entries`. Do not repair the index
   in this plan. Add the one 278 row only.

3. **Agent docs**: in `docs/agents/drone-swarm-project.md`, add a "Create a card from the board"
   section. Describe the per-column button, the modal, the fixed column, the shared `Modal` shell,
   the `ghost` button variant, and the automation consequence. Reference ADR 278.

4. **Package README**: in `drone-swarm-project/README.md`, add one item to "What it does" about the
   add-card button and the modal.

5. **Obsidian wiki** (vault at `/home/unleet/Obsidian/drone-agent-project`):
   - Add a pointer stub `decisions/278-kanban-add-card-ui.md`, with the same shape as
     `decisions/275-kanban-project-create-and-edit-ui.md`.
   - Add the 278 row to `decisions/index.md`.
   - Update `modules/drone-swarm-project.md` with a note about card creation from the board.
   - Append an entry to `log.md`, and update `meta.json`.

## Step 10 — Review pass [agent: review]

Check the work before validation:

- The `Modal` shell owns the backdrop, the panel, the header, and the Escape listener. The three
  migrated modals have no leftover wrapper `div`, no leftover header, and no leftover Escape effect.
- The rendered DOM of `CardModal`, `ProjectModal`, and `QueueModal` is the same as before the
  migration.
- The new-card modal sends `columnId` from the clicked column. It does not send a `position`.
- `BoardPage` reloads the board **and** the project list after a create.
- No change under `drone-swarm-project/src/`.
- No dead code, no unused import, no "step" comment.

## Step 11 — Check the work against the validation criteria [agent: test]

Run every command in section 6. Do not mark the work done until all pass.

---

## 6. Validation criteria

All of these must pass.

1. **LSP** — no errors and no warnings on every changed file. This includes `bundle/Modal.tsx`,
   `bundle/CardCreateModal.tsx`, `bundle/Button.tsx`, `bundle/styles.css`,
   `bundle/BoardPage.tsx`, `bundle/CardModal.tsx`, `bundle/ProjectModal.tsx`,
   `bundle/QueueModal.tsx`, and the test files. The only allowed diagnostics are the pre-existing
   Tailwind `@plugin`/`@custom-variant`/`@theme`/`@apply` warnings in
   `drone-coordinator-ui/src/index.css`, which this plan does not touch.
2. **Build** — `pnpm -r run build` exits 0. This compiles the bundle with esbuild. A broken bundle
   fails this step.
3. **Typecheck** — `pnpm typecheck` exits 0. This includes the bundle's two tsconfigs.
4. **Lint** — `pnpm run lint` exits 0 (eslint, then prettier). Prettier reformats files. Re-read
   every file before a later edit.
5. **Fast test suite** — `pnpm test` passes.
6. **Bundle tests** — `pnpm --filter drone-swarm-project test:ui` passes.
7. **Regression proof** — the new tests fail before the change and pass after. Prove it with file
   backups in `/tmp`. Do **not** use `git stash`. On this host a `git stash push` with a
   non-matching pathspec exits 0 and stashes nothing, and a chained `stash pop` then grabs the
   wrong stash.
8. **Behaviour** — each item below is true:
   - Every column has an "Add card" button at the bottom. The button is full width and always
     visible.
   - Each button has a unique accessible name, `Add card to <column name>`.
   - A click opens the modal. The modal shows the column name. The Title field has focus.
   - The modal has a Title field and a Description field.
   - The Create button is disabled while the title is empty.
   - A create closes the modal, reloads the board, and reloads the project list.
   - The new card appears at the **end** of the clicked column.
   - A failed create shows an inline error and keeps the modal open.
   - Escape closes the modal. A backdrop click closes the modal. A panel click does not.
   - `CardModal`, `ProjectModal`, and `QueueModal` still open, close, and save correctly.
9. **No server change** — `drone-swarm-project/src/**` is unchanged. `pnpm --filter
   drone-swarm-project test` stays green.
10. **Docs** — ADR 278 exists, the index row is present, the agent doc has the new section, and the
    README has the new bullet.
11. **Memory committed** — the new project memory and any insights are committed on
    `feat/kanban-addon-card-ui`, not `main`.

## 7. Out of scope

- **A column picker in the modal.** The column is fixed by the button.
- **Card delete.** No `card.delete` capability exists.
- **A "create another" mode.** The modal closes after one create.
- **A card-bound session.** Creating a card does not start a session by itself. It starts one only
  through a matching wildcard-from automation (D11).
- **A repair of the `docs/adr/index.md` duplicates.** It is a separate followup.
- **A change to the `card.create` handler or its enqueue behaviour.**

---

## Execution summary (2026-11-13, persona `code`, branch `feat/kanban-addon-card-ui`)

**Status: COMPLETE.** All 11 steps done. Commit `7b11368b` (15 files, +627/-171).

### What landed

- **Step 1** `bundle/Modal.tsx` — shared shell (backdrop, panel, header, Escape listener).
- **Step 2** `bundle/Button.tsx` gains `variant="ghost"`; `bundle/styles.css` gains `.dsp-btn-ghost`, `.dsp-add-card`, `.dsp-muted`.
- **Step 3** `bundle/CardCreateModal.tsx` — fixed column, Title + Description, `card.create`.
- **Step 4** `CardModal`, `ProjectModal`, `QueueModal` migrated to the shell (Escape effect and wrapper divs/header removed). Rendered DOM unchanged; their tests unchanged.
- **Step 5** `bundle/BoardPage.tsx` — `newCard` state, per-column ghost button (aria-label `Add card to <name>`), modal render; on create reloads board + `reload()`.
- **Steps 6-8** `bundle/Modal.test.tsx` (4), `bundle/CardCreateModal.test.tsx` (5), `bundle/BoardPage.test.tsx` (+2 = 10).
- **Step 9** ADR `docs/adr/278-kanban-add-card-ui.md` + index row; agent doc section; README bullet; Obsidian stub `decisions/278-kanban-add-card-ui.md` + index row + `modules/drone-swarm-project.md` note + `log.md` entry + `meta.json`.

### Validation (all pass)

- LSP: clean on every changed bundle file. The only diagnostics are the 6 pre-existing Tailwind `@plugin`/`@custom-variant`/`@theme`/`@apply` warnings in `drone-coordinator-ui/src/index.css` (untouched). One `hint` (80006 "may be converted to an async function") on the pre-existing `loadBoard` callback in `BoardPage.tsx`; a hint is below warning, and the line is unchanged by this work.
- `pnpm -r run build` exit 0. `pnpm typecheck` exit 0. `pnpm run lint` exit 0. `pnpm test` 4714 passed / 19 skipped. `pnpm --filter drone-swarm-project test:ui` 36/36.
- Regression proof via `/tmp` file backups (NOT `git stash`): reverting the 6 changed files + deleting the 2 new ones made the new tests fail (2 failed, 3 files failed to resolve); restoring made 36/36 pass.
- `drone-swarm-project/src/**` untouched (git status: 0).

### Plan gap found and fixed

The Step 7 test snippet's base `props` object omits `onCreated`, which is a **required** `CardCreateModalProps` field. `tsc -p bundle/tsconfig.test.json` failed with TS2322/TS2741. Fixed by adding `onCreated: () => {}` to the base `props` in `CardCreateModal.test.tsx`. The component was left as written.
