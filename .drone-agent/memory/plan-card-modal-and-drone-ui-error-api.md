---
key: plan-card-modal-and-drone-ui-error-api
tags:
  - plan
  - drone-swarm-project
  - drone-coordinator-ui
  - drone-extension-ui-types
  - kanban
  - card-modal
  - DroneUI
  - error-api
  - ADR-274
created: 2026-11-10T00:06:32.241Z
updated: 2026-11-10T00:37:03.259Z
---

# Plan — Card modal for the kanban bundle, and a `DroneUI` error API

**Status**: Ready for execution. Branch `feat/kanban-extension-base`.
**Executor**: persona `code`. One reviewer pass at the end.

**EXECUTED — 2026-11-10 (persona `code`).** All 13 steps carried out; validation criteria 1-13 satisfied. Branch `feat/kanban-extension-base`. LSP clean; `pnpm -r run build` / `pnpm typecheck` / `pnpm run lint` exit 0; fast suite 4706 passed / 19 skipped; bundle suite 7/7; host `loader.test.ts` 10/10. Regression proven with `/tmp` file backups (not git stash): CardModal/BoardPage tests fail with Steps 5-7 reverted, pass after. `mcp-swarm` and `src/capabilities.ts` unchanged.

**Gaps the plan did not list (fixed during execution):**
1. `drone-coordinator-ui/src/extensions/types.ts` had to re-export `DroneUI`/`DroneUIErrors` — `loader.ts` imports them from `./types`.
2. Two existing host tests needed the new required `showError` param: `loader.test.ts` `deps()` (added `showError: vi.fn()`) and `useExtensions.test.tsx` `Probe` (`useExtensions(() => {})`).
3. `ExtensionProvider` calls `useToast()`, which throws outside a `ToastProvider` — two extension test files rendered the provider bare and were wrapped in `ToastProvider`.
4. `@types/react-dom` was missing from `drone-swarm-project` devDependencies (`test-setup.ts` imports `react-dom`); added (same version as coordinator-ui).
5. `globals: false` in the bundle vitest config means no testing-library auto-cleanup — `test-setup.ts` registers `afterEach(cleanup)`.
6. The drag-guard test drives `dragstart`/`dragend`/`click` synchronously (`userEvent.click` yields to the event loop and lets the scheduled `didDrag` reset win).

**Pre-existing flake (not a regression):** `drone-coordinator-ui/src/pages/sessions.test.tsx` (untouched file) fails ~30-50% of full-suite runs, a different test name each time, passes 19/19 standalone. WebSocket-debounce timing.

**Validation numbers:** loader.ts 155, useExtensions.tsx 104, ExtensionContext.tsx 219, use-toast.tsx 84, drone-extension-ui-types/src/index.ts 107.

## 1. Summary — what and why

The `drone-swarm-project` kanban extension owns a board: projects, columns, cards, automations, and a spawn queue. The extension declares **23 capabilities**. The web UI uses only 9 of them. A user can drag a card between columns, but the user **cannot open a card**, **cannot read its description**, and **cannot change its title or description**.

This plan adds a **card modal** to the front-end bundle. The modal shows one card and lets the user edit its **title** and **description**. This unlocks two capabilities that the UI does not use today: `card.get` and `card.update`. **Card deletion is out of scope** and stays deferred.

The plan also adds the host API that the modal needs. The bundle has **no error handling today**: every `action()` call ignores failures. The bundle cannot import the host `ErrorBanner` or the toast, because only React is shared with the bundle. So the plan adds a **`DroneUI`** object to the bundle API, exposed as **`api.ui`**. Its first sub-object is **`errors`**, which gives a bundle three error-reporting helpers.

The plan is **bundle-only** for the card feature. No capability changes and no server changes are needed: `POST /api/extensions/:nodeId/actions/:action` runs the caller as `ui`, so the web UI can call any capability, including `ui`-tier capabilities.

## 2. Decisions (locked with the user)

- **D1 — Open gesture.** A **click** opens the modal. A **drag** does not. A `didDrag` ref is set in `onDragStart`, cleared on the next tick, and checked in `onClick`.
- **D2 — Modal data.** The modal is **seeded from the already-loaded card prop**. It does **not** call `card.get`. The editable fields are initialized **once** into local state, so the 3-second board poll cannot overwrite what the user types. On Save: call `card.update`, then reload the board and close.
- **D3 — `api.ui`.** `UIExtensionApi` gains a **field** `ui: DroneUI`. `DroneUI` is a bag of sub-objects keyed by area. The first sub-object is `errors`. The change is **additive**; `mcp-swarm` needs no change.
- **D4 — `DroneUI.errors`.** Three methods. All three go to the host error toast.
- **D5 — Host wiring.** `ExtensionProvider` calls `useToast()`. It threads the toast function **ref-stable** through `useExtensions` into the loader, like `navigate`.
- **D6 — Read-only fields.** The modal shows Status, Column name, Session id, and History. It does **not** show `spawnId` or `position`.
- **D7 — Modal affordances.** Backdrop click, a Close button, and **Escape** all close the modal. A close with unsaved edits discards them silently.
- **D8 — Tests.** Two test surfaces. Host tests extend `loader.test.ts`. A new **package-local jsdom** suite covers the bundle components.
- **D9 — CI.** The new tests run in the **existing `unit-tests` job** of `.github/workflows/integration-test.yml`. The Docker `integration-tests` job does not change.
- **D10 — Docs.** A new **ADR 274** (the next free number), an update to `docs/agents/swarm-extensions.md`, and the Obsidian wiki.
- **D11 — Modal error display.** The modal shows an **inline error line** and **also** calls `ui.errors`. The host toast is raised above extension modals (Step 4), because the bundle modal backdrop has `z-index: 1000` and the toast has `z-index: 50`.

**No change to the capability catalog. No change to `src/`. No server change.**

## 3. Order of work and dependencies

- Steps 1 to 4 are the **host** changes. Do them first. Step 3 needs Step 2, and Step 2 needs Step 1.
- **Build the workspace after Step 1.** `drone-coordinator-ui` resolves `drone-extension-ui-types` from its built `dist/`. Without a build, LSP and typecheck show stale errors.
- Steps 5 to 7 are the **bundle** changes. Step 6 needs Step 5.
- Steps 8 to 9 are the **bundle tests**. They need Steps 5 to 7.
- Step 10 is the **host tests**. It needs Steps 1 to 3.
- Steps 11 to 12 are CI and docs. They need the code to be final.
- Step 13 is validation.

---

## Step 1 — Add the `DroneUI` types [agent: code]

**File**: `drone-extension-ui-types/src/index.ts`

Add these two interfaces **above** `UIExtensionApi`:

```ts
/**
 * Error-reporting helpers the host gives to a bundle. All three report through
 * the host error toast, so a bundle does not need its own error surface.
 */
export interface DroneUIErrors {
  /** Show a message to the user. */
  show: (message: string) => void;
  /**
   * Read a non-ok Response, turn it into a message, show it, and return the
   * message. Ignore the returned promise for a fire-and-forget call.
   */
  fromResponse: (res: Response) => Promise<string>;
  /** Turn a thrown error into a message, show it, and return the message. */
  fromThrown: (err: unknown) => string;
}

/** Host-provided UI helpers. Add a new area as a new field. */
export interface DroneUI {
  errors: DroneUIErrors;
}
```

Add this field to `UIExtensionApi`, after `navigate`:

```ts
  /** Host-provided UI helpers. */
  ui: DroneUI;
```

The two return values on `fromResponse` and `fromThrown` let a caller show the **same** message inline and in the toast. A fire-and-forget caller ignores the return value.

**Then run this command. It rebuilds the dependency package:**

```bash
pnpm -r run build
```

## Step 2 — Build `api.ui` in the loader [agent: code]

**File**: `drone-coordinator-ui/src/extensions/loader.ts`

1. Add the import at the top:

```ts
import { extractApiError, networkErrorMessage } from '@/hooks/use-api';
```

2. Add `DroneUI` to the type import from `./types`.

3. Add this field to `LoaderDeps`:

```ts
  /** Show an error to the user. Handed to bundles via `api.ui.errors`. */
  showError: (message: string) => void;
```

4. Add this function above `makeApi`:

```ts
function makeDroneUI(showError: (message: string) => void): DroneUI {
  return {
    errors: {
      show: message => showError(message),
      fromResponse: async res => {
        const message = await extractApiError(res);
        showError(message);
        return message;
      },
      fromThrown: err => {
        const message = networkErrorMessage(err);
        showError(message);
        return message;
      },
    },
  };
}
```

5. Add a `showError` parameter to `makeApi`. Set the field in the returned object:

```ts
function makeApi(
  registerComponent: LoaderDeps['registerComponent'],
  registerRoute: LoaderDeps['registerRoute'],
  fetchImpl: LoaderDeps['fetch'],
  navigate: LoaderDeps['navigate'],
  showError: LoaderDeps['showError']
): UIExtensionApi {
  return {
    registerComponent: (region, component) =>
      registerComponent(region, component),
    registerRoute,
    fetch: fetchImpl,
    navigate,
    ui: makeDroneUI(showError),
  };
}
```

6. Add `deps.showError` as the last argument of the `makeApi(...)` call inside `loadExtensionBundles`.

`showError` is **required**, like `fetch` and `navigate`. The host always provides it.

## Step 3 — Thread the toast into the provider [agent: code]

**File**: `drone-coordinator-ui/src/extensions/useExtensions.tsx`

1. Change the function signature:

```ts
export function useExtensions(
  showError: (message: string) => void
): ExtensionsLoader {
```

2. Add a ref next to `navigateRef`:

```ts
  const showErrorRef = useRef(showError);
```

3. Add the ref refresh to the existing effect, and add `showError` to its dependency list:

```ts
  useEffect(() => {
    authFetchRef.current = authFetch;
    navigateRef.current = navigate;
    showErrorRef.current = showError;
  }, [authFetch, navigate, showError]);
```

4. Add this line to the `loadExtensionBundles` deps object:

```ts
            showError: message => showErrorRef.current(message),
```

`load` keeps its `[]` dependency list. It reads the ref, so `load` stays reference-stable. This is important. See ADR 273.

**File**: `drone-coordinator-ui/src/extensions/ExtensionContext.tsx`

1. Add the import:

```ts
import { useToast } from '@/hooks/use-toast';
```

2. Inside `ExtensionProvider`, before `useExtensions()`, add:

```ts
  const { error: showError } = useToast();
```

3. Change the call:

```ts
  const extensions = useExtensions(showError);
```

`ExtensionProvider` is inside `ToastProvider`, so `useToast()` is valid there. `useToast().error` is `useCallback`-stable, so the ref pattern keeps `load` stable.

## Step 4 — Raise the host toast above extension modals [agent: code]

**File**: `drone-coordinator-ui/src/hooks/use-toast.tsx`

The bundle modal backdrop is `position: fixed` with `z-index: 1000` (`drone-swarm-project/bundle/styles.css`). The toast viewport is `z-50`. So a toast that a bundle shows **from inside a modal** is hidden behind the backdrop.

Change the viewport class from `z-50` to `z-[1100]`:

```tsx
      <div
        aria-live="assertive"
        className="fixed bottom-4 right-4 z-[1100] flex flex-col gap-2"
      >
```

Host UI must always sit above extension UI. This fix is correct for all extensions, not only this one.

## Step 5 — Add bundle types and the error helper [agent: code]

**File**: `drone-swarm-project/bundle/types.ts`

Add a `MoveRecord` interface, and add `history` and `sessionId` to `Card`:

```ts
export interface MoveRecord {
  at: number;
  actor: 'user' | 'agent' | 'automation';
  fromColumnId: string | null;
  toColumnId: string;
}

export interface Card {
  id: string;
  title: string;
  description?: string;
  columnId: string;
  position: number;
  history?: MoveRecord[];
  sessionId?: string;
  sessionStatus?: 'running' | 'ended' | 'failed';
}
```

**File**: `drone-swarm-project/bundle/api.ts`

Add `DroneUIErrors` to the type import. Add this function:

```ts
/** The host error helpers. Throws when the api is not ready yet. */
export function uiErrors(): DroneUIErrors {
  if (!api) throw new Error('drone-swarm-project: api not ready');
  return api.ui.errors;
}
```

## Step 6 — Add the card modal [agent: code]

**New file**: `drone-swarm-project/bundle/CardModal.tsx`

```tsx
import type { ActionReply, Card, MoveRecord, Project } from './types';
import { action, uiErrors } from './api';

function columnName(project: Project, columnId: string): string {
  const found = project.columns.find(column => column.id === columnId);
  return found?.name ?? columnId;
}

function historyLine(project: Project, record: MoveRecord): string {
  const from = record.fromColumnId
    ? columnName(project, record.fromColumnId)
    : 'new';
  const to = columnName(project, record.toColumnId);
  const when = new Date(record.at).toLocaleString();
  return `${record.actor} · ${from} → ${to} · ${when}`;
}

export function CardModal(props: {
  project: Project;
  card: Card;
  onClose: () => void;
  onSaved: () => void;
}) {
  const React = globalThis.React;
  const { project, card, onClose, onSaved } = props;
  const [title, setTitle] = React.useState(card.title);
  const [description, setDescription] = React.useState(card.description ?? '');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function save(): void {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    void action<ActionReply<{ card: Card }>>('card.update', {
      projectId: project.id,
      cardId: card.id,
      title,
      description,
    })
      .then(reply => {
        if (!reply.ok) {
          const body = reply.body as { error?: string } | undefined;
          const message = body?.error ?? `Update failed (HTTP ${reply.status})`;
          setError(message);
          uiErrors().show(message);
          return;
        }
        onSaved();
      })
      .catch((err: unknown) => setError(uiErrors().fromThrown(err)))
      .finally(() => setSaving(false));
  }

  const history = card.history ?? [];

  return (
    <div className="dsp-modal-backdrop" onClick={onClose}>
      <div className="dsp-modal" onClick={event => event.stopPropagation()}>
        <header className="dsp-modal-header">
          <h2>Card</h2>
          <button onClick={onClose}>Close</button>
        </header>

        <label className="dsp-field">
          Title
          <input
            value={title}
            onChange={event => setTitle(event.target.value)}
          />
        </label>

        <label className="dsp-field">
          Description
          <textarea
            value={description}
            onChange={event => setDescription(event.target.value)}
          />
        </label>

        {error ? <p className="dsp-error">{error}</p> : null}

        <div className="dsp-modal-actions">
          <button onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
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
      </div>
    </div>
  );
}
```

**File**: `drone-swarm-project/bundle/styles.css`

Add these rules. Keep the existing style. The file uses plain CSS, not Tailwind.

```css
.dsp-field {
  display: block;
  margin-bottom: 10px;
}

.dsp-field input,
.dsp-field textarea {
  display: block;
  width: 100%;
  margin-top: 4px;
  font: inherit;
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
  opacity: 0.8;
}
```

## Step 7 — Open the modal from the board [agent: code]

**File**: `drone-swarm-project/bundle/BoardPage.tsx`

1. Add the import:

```ts
import { CardModal } from './CardModal';
```

2. Add state and a drag guard next to the existing state:

```ts
  const [openCardId, setOpenCardId] = React.useState<string | undefined>(
    undefined
  );
  const didDrag = React.useRef(false);
```

3. Add `onDragEnd` and `onClick` to the card `<div>`. Keep the existing `draggable` and `onDragStart`.

```tsx
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
```

4. Render the modal after the columns block, next to the existing `QueueModal` line:

```tsx
      {openCardId
        ? (() => {
            const card = project?.cards.find(c => c.id === openCardId);
            return card && project ? (
              <CardModal
                project={project}
                card={card}
                onClose={() => setOpenCardId(undefined)}
                onSaved={() => {
                  setOpenCardId(undefined);
                  void loadBoard(selected);
                }}
              />
            ) : null;
          })()
        : null}
```

The `didDrag` guard works like this: a drag sets `didDrag` to true in `onDragStart`. The click that can follow a drag reads `true` and returns. The `setTimeout(..., 0)` in `onDragEnd` clears the flag after the click. A plain click never sets the flag.

## Step 8 — Add the bundle test infrastructure [agent: code]

**File**: `drone-swarm-project/package.json`

1. Add these devDependencies. Copy the versions from `drone-coordinator-ui`:

```json
    "@testing-library/jest-dom": "^7.0.0",
    "@testing-library/react": "^16.3.2",
    "@testing-library/user-event": "^14.6.1",
    "jsdom": "^29.1.1",
    "react-dom": "^19.0.0",
```

2. Add the `test:ui` script. Keep the existing `test` script.

```json
    "test:ui": "NODE_ENV=test vitest run -c vitest.config.ts",
```

3. Extend the `typecheck` script to check the tests:

```json
    "typecheck": "tsc -b --pretty false && tsc -p bundle/tsconfig.json && tsc -p bundle/tsconfig.test.json",
```

**New file**: `drone-swarm-project/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['bundle/**/*.test.tsx'],
    environment: 'jsdom',
    setupFiles: ['bundle/test-setup.ts'],
    globals: false,
  },
});
```

**New file**: `drone-swarm-project/bundle/test-setup.ts`

The bundle uses `globalThis.React` as its JSX factory. The test host must install React before a test renders a bundle component.

```ts
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import * as ReactDOM from 'react-dom';

(globalThis as unknown as { React: typeof React }).React = React;
(globalThis as unknown as { ReactDOM: typeof ReactDOM }).ReactDOM = ReactDOM;
```

**File**: `drone-swarm-project/bundle/tsconfig.json`

Add an `exclude`, so the shipped-bundle typecheck stays on browser source only:

```json
  "exclude": ["**/*.test.tsx", "test-setup.ts"]
```

**New file**: `drone-swarm-project/bundle/tsconfig.test.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["**/*.ts", "**/*.tsx", "globals.d.ts"],
  "exclude": []
}
```

**Then run this command, to install the new devDependencies:**

```bash
pnpm install
```

## Step 9 — Add the bundle tests [agent: test]

**New file**: `drone-swarm-project/bundle/CardModal.test.tsx`

Cover: seeded fields, Save calls `card.update`, a failed reply shows the inline error and stays open, and the read-only fields render.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CardModal } from './CardModal';
import { setApi } from './api';
import type { Card, Project } from './types';

const project: Project = {
  id: 'p_1',
  name: 'Alpha',
  columns: [
    { id: 'col_todo', name: 'Todo', order: 0 },
    { id: 'col_done', name: 'Done', order: 1 },
  ],
  cards: [],
};

const card: Card = {
  id: 'c_1',
  title: 'Old title',
  description: 'Old body',
  columnId: 'col_todo',
  position: 0,
  sessionStatus: 'running',
  sessionId: 'sess-1',
  history: [
    { at: 1000, actor: 'user', fromColumnId: null, toColumnId: 'col_todo' },
  ],
};

function installApi(reply: unknown) {
  const fetchImpl = vi.fn(async () => ({
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

describe('CardModal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('seeds the editable fields from the card', () => {
    installApi({ ok: true, body: {} });
    render(
      <CardModal
        project={project}
        card={card}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    expect(screen.getByDisplayValue('Old title')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Old body')).toBeInTheDocument();
  });

  it('shows the read-only details', () => {
    installApi({ ok: true, body: {} });
    render(
      <CardModal
        project={project}
        card={card}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    expect(screen.getByText('running')).toBeInTheDocument();
    expect(screen.getByText('Todo')).toBeInTheDocument();
    expect(screen.getByText('sess-1')).toBeInTheDocument();
  });

  it('sends card.update on Save and calls onSaved', async () => {
    const user = userEvent.setup();
    const fetchImpl = installApi({ ok: true, body: { card } });
    const onSaved = vi.fn();
    render(
      <CardModal
        project={project}
        card={card}
        onClose={() => {}}
        onSaved={onSaved}
      />
    );
    const input = screen.getByDisplayValue('Old title');
    await user.clear(input);
    await user.type(input, 'New title');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const [, init] = fetchImpl.mock.calls[0]!;
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent.params.title).toBe('New title');
    expect(String(fetchImpl.mock.calls[0]![0])).toContain('card.update');
  });

  it('shows an inline error and stays open when the reply is not ok', async () => {
    const user = userEvent.setup();
    installApi({ ok: false, status: 400, body: { error: 'bad card' } });
    const onSaved = vi.fn();
    render(
      <CardModal
        project={project}
        card={card}
        onClose={() => {}}
        onSaved={onSaved}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('bad card')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    installApi({ ok: true, body: {} });
    const onClose = vi.fn();
    render(
      <CardModal
        project={project}
        card={card}
        onClose={onClose}
        onSaved={() => {}}
      />
    );
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

**New file**: `drone-swarm-project/bundle/BoardPage.test.tsx`

Cover the drag guard: a plain click opens the modal, and a drag followed by a click does not.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardPage } from './BoardPage';
import { setApi } from './api';

const project = {
  id: 'p_1',
  name: 'Alpha',
  columns: [{ id: 'col_todo', name: 'Todo', order: 0 }],
  cards: [
    {
      id: 'c_1',
      title: 'Card one',
      columnId: 'col_todo',
      position: 0,
      history: [],
    },
  ],
};

function installApi() {
  setApi({
    registerComponent: () => () => {},
    registerRoute: () => () => {},
    fetch: vi.fn(async (path: string) => ({
      ok: true,
      json: async () =>
        String(path).endsWith('/project.list')
          ? { ok: true, body: { projects: [{ id: 'p_1', name: 'Alpha', cardCount: 1 }] } }
          : { ok: true, body: { project } },
    })) as unknown as typeof fetch,
    navigate: () => {},
    ui: {
      errors: {
        show: vi.fn(),
        fromResponse: vi.fn(async () => 'x'),
        fromThrown: vi.fn(() => 'x'),
      },
    },
  });
}

describe('BoardPage', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('opens the card modal on a click', async () => {
    const user = userEvent.setup();
    installApi();
    render(<BoardPage />);
    const title = await screen.findByText('Card one');
    await user.click(title);
    expect(await screen.findByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('does not open the modal when the click follows a drag', async () => {
    const user = userEvent.setup();
    installApi();
    render(<BoardPage />);
    const title = await screen.findByText('Card one');
    const cardEl = title.closest('.dsp-card')!;
    // A drag fires dragStart, then dragEnd, then (in some browsers) a click.
    cardEl.dispatchEvent(new Event('dragstart', { bubbles: true }));
    cardEl.dispatchEvent(new Event('dragend', { bubbles: true }));
    await user.click(title);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    );
  });
});
```

**Run the suite:**

```bash
pnpm --filter drone-swarm-project test:ui
```

## Step 10 — Add the host tests [agent: test]

**File**: `drone-coordinator-ui/src/extensions/loader.test.ts`

1. Add `showError: vi.fn()` to the `deps()` helper, next to `fetch` and `navigate`.

2. Add these cases:

```ts
  it('hands the error helpers to bundles via api.ui.errors', async () => {
    const onReady = vi.fn();
    const showError = vi.fn();
    await loadExtensionBundles(entry(), {
      ...deps(),
      importModule: vi.fn().mockResolvedValue({ default: { onReady } }),
      showError,
    });
    const api = onReady.mock.calls[0][0];
    api.ui.errors.show('boom');
    expect(showError).toHaveBeenCalledWith('boom');
  });

  it('normalizes a non-ok response in fromResponse', async () => {
    const onReady = vi.fn();
    const showError = vi.fn();
    await loadExtensionBundles(entry(), {
      ...deps(),
      importModule: vi.fn().mockResolvedValue({ default: { onReady } }),
      showError,
    });
    const api = onReady.mock.calls[0][0];
    const res = {
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: async () => ({ error: 'nope' }),
    } as unknown as Response;
    const message = await api.ui.errors.fromResponse(res);
    expect(message).toBe('nope');
    expect(showError).toHaveBeenCalledWith('nope');
  });

  it('normalizes a thrown error in fromThrown', async () => {
    const onReady = vi.fn();
    const showError = vi.fn();
    await loadExtensionBundles(entry(), {
      ...deps(),
      importModule: vi.fn().mockResolvedValue({ default: { onReady } }),
      showError,
    });
    const api = onReady.mock.calls[0][0];
    const message = api.ui.errors.fromThrown(new Error('offline'));
    expect(message).toBe('offline');
    expect(showError).toHaveBeenCalledWith('offline');
  });
```

Use the file's existing helper to build the `entry()` argument. If the file has no such helper, build the entry inline, like the existing cases do.

## Step 11 — Run the new tests in CI [agent: code]

**File**: `.github/workflows/integration-test.yml`

Add this step to the **`unit-tests`** job, directly after the `Run unit tests` step:

```yaml
      - name: Run UI package tests
        run: |
          pnpm --filter drone-coordinator-ui test
          pnpm --filter drone-swarm-project test:ui
```

This step also closes a **pre-existing gap**: the `drone-coordinator-ui` suite (371 tests) does not run in CI today, because the root `pnpm test` does not include that package.

Do **not** change the `integration-tests` job. The new tests need no services.

## Step 12 — Documentation [agent: code]

1. **New ADR**: `docs/adr/274-card-modal-and-drone-ui-error-api.md`.

   Content:
   - **Context.** The board bundle declares 23 capabilities. The UI uses 9. A user cannot open a card or edit it. The bundle also has no error handling, because it cannot import the host error surfaces.
   - **Decision.**
     - **D1** the card modal opens on a click, not on a drag (a `didDrag` guard).
     - **D2** the modal is seeded from the loaded card, and the editable fields are frozen against the board poll.
     - **D3** `UIExtensionApi` gains `ui: DroneUI`; the first sub-object is `errors`.
     - **D4** `DroneUI.errors` has `show`, `fromResponse`, and `fromThrown`, all of which report through the host toast. `fromResponse` and `fromThrown` return the normalized message.
     - **D5** the host toast moves above extension modals (`z-[1100]`).
     - **D6** card deletion is out of scope.
   - **Consequences.** `card.get` and `card.update` become reachable from the UI. A bundle can now report an error without its own error surface. The change is additive; `mcp-swarm` is unaffected.
   - **Amends** ADR 254 D7 (the bundle API contract).

2. **Index row**: add a row for 274 at the top of `docs/adr/index.md`, above the 273 row. Then run these checks:

   ```bash
   ls docs/adr | grep -E '^[0-9]{3}-' | sed 's/-.*//' | sort | uniq -d   # must be empty
   sed -n '1,3p' docs/adr/index.md                                       # no prose above the table
   ```

   **Known pre-existing defect.** The `grep -c '^| \['` count does **not** equal the file count, and it did not before this change either. The index has 27 duplicated rows and 5 missing rows. This is tracked as project memory `followup-adr-index-duplicate-rows-and-missing-entries`. Do not repair the index in this plan. Add the one 274 row and move on.

3. **Agent docs**: in `docs/agents/swarm-extensions.md`, extend the "Front-end bundles" section. State that `onReady(api)` receives `ui: DroneUI`, and describe `api.ui.errors`. Reference ADR 274.

4. **Obsidian wiki** (vault at `/home/unleet/Obsidian/drone-agent-project`):
   - Add a pointer stub `decisions/274-card-modal-and-drone-ui-error-api.md`, with the same shape as `decisions/273-extension-registry-navigation-teardown.md`.
   - Add the 274 row to `decisions/index.md`.
   - In `modules/drone-swarm-project.md`, add a note about the card modal.
   - In `modules/drone-coordinator-ui.md`, add a note about `api.ui` and the toast z-index.
   - Update `index.md`: ADR count 273 to 274, and the Latest pointer.
   - Append a section to the coordinator-scope page `drone-coordinator-ui-frontend-extension-system-as-built`.
   - Append an entry to `log.md`, and update `meta.json`.

## Step 13 — Check the work against the validation criteria [agent: test]

Run every command in section 4. Do not mark the work done until all pass.

---

## 4. Validation criteria

All of these must pass.

1. **LSP** — no errors or warnings on every changed file:
   `drone-extension-ui-types/src/index.ts`, `drone-coordinator-ui/src/extensions/loader.ts`, `drone-coordinator-ui/src/extensions/useExtensions.tsx`, `drone-coordinator-ui/src/extensions/ExtensionContext.tsx`, `drone-coordinator-ui/src/hooks/use-toast.tsx`, `drone-swarm-project/bundle/*.tsx`, and the two test files.
2. **Build** — `pnpm -r run build` exits 0. Run it **before** LSP and typecheck, because `drone-extension-ui-types` and `drone-swarm-project` are resolved from `dist/`.
3. **Typecheck** — `pnpm typecheck` exits 0.
4. **Lint** — `pnpm run lint` exits 0 (eslint, then prettier). Prettier reformats files, so re-read every file before a later edit.
5. **Fast test suite** — `pnpm test` passes.
6. **UI package tests** — `pnpm --filter drone-coordinator-ui test` passes. This script sets `NODE_ENV=test`.
7. **Bundle tests** — `pnpm --filter drone-swarm-project test:ui` passes.
8. **Regression proof** — the new bundle tests fail before Steps 5 to 7, and pass after. Prove it with file backups in `/tmp`. Do **not** use `git stash`: on this host a `git stash push` with a non-matching pathspec exits 0 and stashes nothing, and a chained `stash pop` then grabs the wrong stash.
9. **Behavior** (manual, or covered by tests):
   - A click on a card opens the modal. A drag does not.
   - The modal shows the card title and description, and the read-only Status, Column, Session, and History.
   - A Save sends `card.update`, closes the modal, and reloads the board.
   - A failed Save shows the inline error and keeps the modal open.
   - A bundle error toast is visible above an open modal.
10. **CI** — the `unit-tests` job in `.github/workflows/integration-test.yml` runs both new test commands. The `integration-tests` job is unchanged.
11. **Additive API** — `mcp-swarm` builds and its tests pass without a change. `UIExtensionApi.ui` is the only new member.
12. **No capability change** — `src/capabilities.ts` is unchanged. `drone-swarm-project/test/capabilities.test.ts` passes unchanged.
13. **Memory committed** — the new project memory and any insights are committed on `feat/kanban-extension-base`, not `main`.

## 5. Out of scope

- **Card deletion.** No `card.delete` capability exists. It needs a new capability, a store method, and a handler case. Deferred by decision.
- `card.create`, project create/update/delete, column rename/reorder, the automation editor, and positional reorder.
- A version-skew guard for an old host without `api.ui`. The host and the bundle ship from one repository and deploy together.
- Repair of the `docs/adr/index.md` duplicate and missing rows. Tracked as a separate followup.
