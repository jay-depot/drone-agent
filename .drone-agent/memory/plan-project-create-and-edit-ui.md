---
key: plan-project-create-and-edit-ui
tags:
  - plan
  - drone-swarm-project
  - drone-coordinator-ui
  - swarm-extension
  - front-end-bundle
  - kanban
  - project-create
  - project-update
  - ADR-275
created: 2026-11-10T01:20:00.000Z
updated: 2026-11-10T01:20:00.000Z
---

# Plan — Create and edit projects in the kanban bundle

**Status**: Ready for execution. Branch `feat/kanban-extension-base`.
**Executor**: persona `code`. One reviewer pass at the end.

## 1. Summary — what and why

`drone-swarm-project` is a swarm extension that owns a kanban board. A **project** is a namespace. It owns ordered columns, cards, and automations. A project also carries `defaultBeaconId` and `defaultWorkingDir`. An automation **inherits** these two values today. Nothing can override them yet. So the values must be set at the project.

The web UI cannot create a project. It cannot change a project name or its defaults. The `project.create` and `project.update` capabilities already exist. They are `ui`-tier capabilities, so the web UI can call them. But **no UI code calls them**.

This plan adds **project creation and project editing** to the front-end bundle.

- The project dropdown on the **board page** and on the **settings panel** gains a `New Project…` option at the end. This option opens a **New Project modal**.
- The **board page** gains a separate `Edit Project` button. The button acts on the selected project. It opens the **same modal** in edit mode.
- The modal has three fields: **Name** (required), **Beacon**, and **Working directory**.

The plan adds a shared `ProjectSelect` component and a shared `useProjects()` hook. Both pages use both. This removes the current duplication.

**No server change is needed.** `project.create` and `project.update` are unchanged. Their parameter schemas already accept the three fields.

## 2. Decisions (locked with the user)

- **D1 — Sentinel option.** Each project dropdown gains `New Project…` as the last option. The value of the sentinel is `__new_project__`. The dropdown is controlled. When the user picks the sentinel, the code opens the modal and does **not** change the selection. The sentinel value never becomes the selection.
- **D2 — Modal fields.** The modal has exactly three fields: **Name** (required), **Beacon**, and **Working directory**.
- **D3 — Beacon picker.** The Beacon field is a `<select>` of **connected** beacons. The code reads `GET /api/beacons` and keeps `connected === true`.
- **D4 — Working-directory picker.** The Working directory field is a `<select>`. Its options are the selected beacon's advertised `spawnRoots`. The seed value is `defaultSpawnRoot ?? spawnRoots[0]`. The list is re-seeded when the beacon changes. This mirrors `NewSessionPanel` in `drone-coordinator-ui/src/pages/sessions.tsx`.
- **D5 — Exclusion of extension nodes.** The coordinator registers an extension node as a beacon. So `GET /api/beacons` includes extension nodes. They cannot spawn sessions. The code reads `GET /api/extensions` and removes every node with `isExtension === true` from the beacon picker.
- **D6 — No connected beacon.** When no connected beacon exists, the modal still creates a project. The beacon and working directory stay unset.
- **D7 — After a create.** The new project becomes the selected project. The modal closes. The project list reloads.
- **D8 — Scope.** Create and edit are in scope. **Delete is out of scope.** It stays deferred.
- **D9 — Edit location.** The `Edit Project` button is on the **board page only**. It is next to the project dropdown. It is **not** in the settings panel.
- **D10 — Edit target.** The `Edit Project` button acts on the **currently selected** project. The button is **disabled** when no project is selected.
- **D11 — One modal.** One `ProjectModal` component serves both modes. It takes a `mode: 'create' | 'edit'` prop.
- **D12 — Stored value is never lost.** In edit mode, a stored beacon or working directory that is not in the live list is still shown as an option. It is annotated (for example `my-beacon (offline)`). It is preselected. The value changes only when the user selects another option.
- **D13 — Empty board.** When the board has zero projects, the columns area shows a short hint and a `New Project` button.
- **D14 — Shared code.** A `ProjectSelect` component and a `useProjects()` hook replace the duplicated dropdown and the duplicated list logic in both pages.

## 3. Order of work and dependencies

- Steps 1 to 3 are **shared bundle modules**. Do them first. Step 2 needs Step 1.
- Steps 4 and 5 are the **modal**. Step 5 needs Step 2 and Step 3.
- Steps 6 to 8 are the **pages**. Step 6 needs Steps 2 to 5. Step 7 needs Steps 1 to 3.
- Steps 9 to 11 are the **tests**. They need Steps 1 to 8.
- Steps 12 to 13 are docs. They need the code to be final.
- Step 14 is validation.

After Step 4, run the bundle build to check the code:

```bash
pnpm --filter drone-swarm-project run build
```

---

## Step 1 — Add the bundle types [agent: code]

**File**: `drone-swarm-project/bundle/types.ts`

1. Add `defaultBeaconId` and `defaultWorkingDir` to `Project`. The store returns both. The `board.get` reply carries the full project.

```ts
export interface Project {
  id: string;
  name: string;
  columns: Column[];
  cards: Card[];
  defaultBeaconId?: string;
  defaultWorkingDir?: string;
}
```

2. Add two coordinator REST shapes. These are not action replies. They come from `GET /api/beacons` and `GET /api/extensions`.

```ts
/** One row of `GET /api/beacons`. */
export interface BeaconRow {
  id: string;
  name: string;
  connected?: boolean;
  spawnRoots?: string[];
  defaultSpawnRoot?: string;
}

/** One row of `GET /api/extensions`. */
export interface ExtensionRow {
  nodeId: string;
  connected: boolean;
  isExtension?: boolean;
}
```

## Step 2 — Add a REST fetch helper and the beacon loader [agent: code]

**File**: `drone-swarm-project/bundle/api.ts`

1. Add a REST fetch helper. The module already holds the host `api`. This helper reuses it.

```ts
/** Authenticated same-origin fetch against the coordinator API. */
export async function apiFetch(
  path: string,
  init?: RequestInit
): Promise<Response> {
  if (!api) throw new Error('drone-swarm-project: api not ready');
  return api.fetch(path, init);
}
```

**New file**: `drone-swarm-project/bundle/beacons.ts`

```ts
import type { BeaconRow, ExtensionRow } from './types';
import { apiFetch } from './api';

/** A beacon the New Project modal can offer. */
export interface PickerBeacon {
  id: string;
  name: string;
  spawnRoots: string[];
  defaultSpawnRoot?: string;
}

/**
 * Load the beacons a project may target.
 *
 * `GET /api/beacons` also returns extension nodes (the coordinator registers
 * each extension node as a beacon). An extension node cannot spawn a session,
 * so it is removed. `GET /api/extensions` reports `isExtension` for this.
 */
export async function loadPickerBeacons(): Promise<PickerBeacon[]> {
  const [beaconsRes, extensionsRes] = await Promise.all([
    apiFetch('/api/beacons'),
    apiFetch('/api/extensions'),
  ]);
  const beacons = beaconsRes.ok
    ? ((await beaconsRes.json()) as BeaconRow[])
    : [];
  const extensions = extensionsRes.ok
    ? ((await extensionsRes.json()) as ExtensionRow[])
    : [];
  const extensionIds = new Set(
    extensions.filter(entry => entry.isExtension).map(entry => entry.nodeId)
  );
  return beacons
    .filter(beacon => beacon.connected && !extensionIds.has(beacon.id))
    .map(beacon => ({
      id: beacon.id,
      name: beacon.name || beacon.id,
      spawnRoots: beacon.spawnRoots ?? [],
      defaultSpawnRoot: beacon.defaultSpawnRoot,
    }));
}
```

## Step 3 — Add the shared project hook and select [agent: code]

**New file**: `drone-swarm-project/bundle/useProjects.ts`

This hook owns the project list, the default-selection rule, and the reload. Both pages use it. The default-selection rule uses `current ?? first`. So it does not change an existing selection.

```ts
import type { ActionReply, ProjectSummary } from './types';
import { action } from './api';

/** The sentinel option value that opens the New Project modal. */
export const NEW_PROJECT_VALUE = '__new_project__';

export interface UseProjects {
  projects: ProjectSummary[];
  selected: string | undefined;
  setSelected: (id: string | undefined) => void;
  reload: () => Promise<ProjectSummary[]>;
}

/**
 * Load the project list and keep the selected project.
 *
 * The selection rule keeps the current project. It selects the first project
 * only when nothing is selected. So a reload does not change the selection.
 */
export function useProjects(): UseProjects {
  const React = globalThis.React;
  const [projects, setProjects] = React.useState<ProjectSummary[]>([]);
  const [selected, setSelected] = React.useState<string | undefined>(undefined);

  const reload = React.useCallback((): Promise<ProjectSummary[]> => {
    return action<ActionReply<{ projects: ProjectSummary[] }>>(
      'project.list'
    ).then(reply => {
      const list = reply.body?.projects ?? [];
      setProjects(list);
      setSelected(current => current ?? list[0]?.id);
      return list;
    });
  }, []);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  return { projects, selected, setSelected, reload };
}
```

**New file**: `drone-swarm-project/bundle/ProjectSelect.tsx`

```tsx
import type { ProjectSummary } from './types';
import { NEW_PROJECT_VALUE } from './useProjects';

export interface ProjectSelectProps {
  projects: ProjectSummary[];
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  onNewProject: () => void;
  /** Show the card count next to each project name. */
  showCount?: boolean;
  className?: string;
}

/**
 * The project dropdown, with the `New Project…` sentinel.
 *
 * The select is controlled. A pick of the sentinel calls `onNewProject` and
 * does not call `onChange`. So the sentinel value never becomes the selection.
 */
export function ProjectSelect(props: ProjectSelectProps) {
  const React = globalThis.React;
  const { projects, value, onChange, onNewProject, showCount, className } =
    props;

  function onSelect(next: string): void {
    if (next === NEW_PROJECT_VALUE) {
      onNewProject();
      return;
    }
    onChange(next || undefined);
  }

  return (
    <select
      className={className}
      value={value ?? ''}
      onChange={event => onSelect(event.target.value)}
    >
      {projects.map(item => (
        <option key={item.id} value={item.id}>
          {showCount ? `${item.name} (${item.cardCount})` : item.name}
        </option>
      ))}
      <option value={NEW_PROJECT_VALUE}>New Project…</option>
    </select>
  );
}
```

## Step 4 — Add the project modal [agent: code]

**New file**: `drone-swarm-project/bundle/ProjectModal.tsx`

One component, two modes. Create mode calls `project.create`. Edit mode calls `project.update` and sends `projectId`. The structure follows `CardModal`: backdrop click, a Close button, Escape, an inline error line, and a host toast on failure.

```tsx
import type { ActionReply, Project } from './types';
import { action, uiErrors } from './api';
import { loadPickerBeacons, type PickerBeacon } from './beacons';

export interface ProjectModalProps {
  mode: 'create' | 'edit';
  /** The project to edit. Required in edit mode. */
  project?: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}

const NONE = '';

export function ProjectModal(props: ProjectModalProps) {
  const React = globalThis.React;
  const { mode, project, onClose, onSaved } = props;

  const [name, setName] = React.useState(project?.name ?? '');
  const [beacons, setBeacons] = React.useState<PickerBeacon[]>([]);
  const [beaconId, setBeaconId] = React.useState(
    project?.defaultBeaconId ?? NONE
  );
  const [workingDir, setWorkingDir] = React.useState(
    project?.defaultWorkingDir ?? NONE
  );
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | undefined>(undefined);

  React.useEffect(() => {
    let cancelled = false;
    void loadPickerBeacons()
      .then(list => {
        if (cancelled) return;
        setBeacons(list);
        setBeaconId(current => {
          if (current) return current;
          return mode === 'create' ? (list[0]?.id ?? NONE) : NONE;
        });
        setWorkingDir(current => {
          if (current) return current;
          if (mode !== 'create') return NONE;
          const first = list[0];
          return first?.defaultSpawnRoot ?? first?.spawnRoots[0] ?? NONE;
        });
      })
      .catch(() => {
        if (!cancelled) setBeacons([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  React.useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Keep a stored beacon that is not in the live list, so the value is never
  // silently rewritten. It shows with an `(offline)` note.
  const beaconOptions: PickerBeacon[] = [...beacons];
  if (beaconId && !beaconOptions.some(beacon => beacon.id === beaconId)) {
    beaconOptions.push({
      id: beaconId,
      name: `${beaconId} (offline)`,
      spawnRoots: [],
    });
  }

  const activeBeacon = beaconOptions.find(beacon => beacon.id === beaconId);
  const rootOptions: string[] = [...(activeBeacon?.spawnRoots ?? [])];
  if (workingDir && !rootOptions.includes(workingDir)) {
    rootOptions.push(workingDir);
  }

  function onBeaconChange(nextId: string): void {
    setBeaconId(nextId);
    if (
      project &&
      nextId === project.defaultBeaconId &&
      project.defaultWorkingDir
    ) {
      setWorkingDir(project.defaultWorkingDir);
      return;
    }
    const next = beaconOptions.find(beacon => beacon.id === nextId);
    setWorkingDir(next?.defaultSpawnRoot ?? next?.spawnRoots[0] ?? NONE);
  }

  function save(): void {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(undefined);
    const params: Record<string, unknown> = {
      name: trimmed,
      defaultBeaconId: beaconId || undefined,
      defaultWorkingDir: workingDir || undefined,
    };
    if (mode === 'edit' && project) params.projectId = project.id;
    const capability = mode === 'edit' ? 'project.update' : 'project.create';

    void action<ActionReply<{ project: Project }>>(capability, params)
      .then(reply => {
        const saved = reply.body?.project;
        if (!reply.ok || !saved) {
          const body = reply.body as { error?: string } | undefined;
          const message = body?.error ?? `Save failed (HTTP ${reply.status})`;
          setError(message);
          uiErrors().show(message);
          return;
        }
        onSaved(saved);
      })
      .catch((err: unknown) => setError(uiErrors().fromThrown(err)))
      .finally(() => setSaving(false));
  }

  const title = mode === 'edit' ? 'Edit Project' : 'New Project';
  const submitLabel = mode === 'edit' ? 'Save' : 'Create';

  return (
    <div className="dsp-modal-backdrop" onClick={onClose}>
      <div className="dsp-modal" onClick={event => event.stopPropagation()}>
        <header className="dsp-modal-header">
          <h2>{title}</h2>
          <button onClick={onClose}>Close</button>
        </header>

        <label className="dsp-field">
          Name
          <input value={name} onChange={event => setName(event.target.value)} />
        </label>

        <label className="dsp-field">
          Beacon
          <select
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
          <button onClick={save} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Note for the executor.** `project.update` treats an empty `defaultWorkingDir` as "no change". So the modal can change a working directory but cannot clear it. This is a known limit. It is out of scope to change the handler.

## Step 5 — Add modal styles [agent: code]

**File**: `drone-swarm-project/bundle/styles.css`

The modal classes exist. Add a rule for the empty-board hint. Add a rule for a small inline button row if needed.

```css
.dsp-empty-hint {
  padding: 24px;
  text-align: center;
  opacity: 0.8;
}

.dsp-empty-hint p {
  margin-bottom: 10px;
}
```

## Step 6 — Use the shared pieces on the board page [agent: code]

**File**: `drone-swarm-project/bundle/BoardPage.tsx`

1. Change the imports:

```ts
import type { ActionReply, Card, Column, Project } from './types';
import { action } from './api';
import { QueueModal } from './QueueModal';
import { CardModal } from './CardModal';
import { ProjectModal } from './ProjectModal';
import { ProjectSelect } from './ProjectSelect';
import { useProjects } from './useProjects';
```

2. Replace the local `projects` and `selected` state with the hook, and add the modal state:

```ts
const { projects, selected, setSelected, reload } = useProjects();
const [project, setProject] = React.useState<Project | undefined>(undefined);
const [queueOpen, setQueueOpen] = React.useState(false);
const [modal, setModal] = React.useState<
  { mode: 'create' } | { mode: 'edit' } | undefined
>(undefined);
const dragCard = React.useRef<string | undefined>(undefined);
const [openCardId, setOpenCardId] = React.useState<string | undefined>(
  undefined
);
const didDrag = React.useRef(false);
```

3. Remove `loadProjects`. Keep `loadBoard` and the two effects. The board effect stays:

```ts
React.useEffect(() => {
  void loadBoard(selected);
  const timer = setInterval(() => void loadBoard(selected), POLL_MS);
  return () => clearInterval(timer);
}, [selected, loadBoard]);
```

4. Replace the header block. The `Edit Project` button is disabled when no project is selected or the project is not loaded.

```tsx
<header className="dsp-board-header">
  <ProjectSelect
    projects={projects}
    value={selected}
    onChange={setSelected}
    onNewProject={() => setModal({ mode: 'create' })}
    showCount
  />
  <button
    disabled={!selected || !project}
    onClick={() => setModal({ mode: 'edit' })}
  >
    Edit Project
  </button>
  <button onClick={() => setQueueOpen(true)}>Queue</button>
</header>
```

5. Add the empty-board hint. Put it inside `dsp-columns` when `projects.length === 0`.

```tsx
      <div className="dsp-columns">
        {projects.length === 0 ? (
          <div className="dsp-empty-hint">
            <p>No projects yet.</p>
            <button onClick={() => setModal({ mode: 'create' })}>
              New Project
            </button>
          </div>
        ) : null}
        {columns.map(column => (
          /* unchanged column markup */
        ))}
      </div>
```

6. Render the modal next to the `QueueModal` line. The `onSaved` handler reloads the list, then selects the saved project.

```tsx
{
  modal ? (
    <ProjectModal
      mode={modal.mode}
      project={modal.mode === 'edit' ? project : undefined}
      onClose={() => setModal(undefined)}
      onSaved={saved => {
        setModal(undefined);
        void reload().then(() => setSelected(saved.id));
      }}
    />
  ) : null;
}
```

## Step 7 — Use the shared pieces on the settings panel [agent: code]

**File**: `drone-swarm-project/bundle/BoardSettings.tsx`

1. Change the imports:

```ts
import type { ActionReply, Column, Limits, Project } from './types';
import { action } from './api';
import { ProjectSelect } from './ProjectSelect';
import { useProjects } from './useProjects';
```

2. Replace the local `projects` and `selected` state with the hook:

```ts
const { projects, selected, setSelected, reload } = useProjects();
const [project, setProject] = React.useState<Project | undefined>(undefined);
const [limits, setLimits] = React.useState<Limits | undefined>(undefined);
const [newColumn, setNewColumn] = React.useState('');

const loadLimits = React.useCallback(() => {
  void action<ActionReply<{ limits: Limits }>>('limits.get').then(reply =>
    setLimits(reply.body?.limits)
  );
}, []);

const refresh = React.useCallback(() => {
  void reload();
  loadLimits();
}, [reload, loadLimits]);

React.useEffect(() => {
  loadLimits();
}, [loadLimits]);

React.useEffect(() => {
  if (!selected) {
    setProject(undefined);
    return;
  }
  void action<ActionReply<{ project: Project }>>('board.get', {
    projectId: selected,
  }).then(reply => setProject(reply.body?.project));
}, [selected]);
```

3. Replace the header select with the shared component. The `New Project` action only needs to select the new project on this page. It does not need a modal here (the modal lives on the board page). So pass a handler that does nothing visible except that the sentinel must not change the selection. The simplest correct option is to keep the sentinel purely presentational: it opens nothing.

**Decision for the executor.** The settings panel must still show the sentinel, because the user asked for the option on both pages. But the modal is on the board page. Two correct options:

- Option A: the settings sentinel navigates to the board page. Use `api.navigate('/board')`.
- Option B: the settings sentinel opens the same `ProjectModal` here too.

Do **Option A**. It keeps one modal in one place, and the board is where a new project is then shown. Add `navigate` to `api.ts`:

```ts
/** Navigate to a client route without a page reload. */
export function apiNavigate(path: string): void {
  if (!api) throw new Error('drone-swarm-project: api not ready');
  api.navigate(path);
}
```

Then in `BoardSettings`:

```tsx
        <ProjectSelect
          projects={projects}
          value={selected}
          onChange={setSelected}
          onNewProject={() => apiNavigate('/board')}
        />
        <button onClick={refresh}>Refresh</button>
```

## Step 8 — Update the existing board test mock [agent: test]

**File**: `drone-swarm-project/bundle/BoardPage.test.tsx`

The existing tests stay. The `installApi` mock already answers `project.list` and `board.get`. Confirm the two existing tests still pass. They do not open the project modal, so they do not call `/api/beacons`.

## Step 9 — Add the hook test [agent: test]

**New file**: `drone-swarm-project/bundle/useProjects.test.tsx`

Cover:

- The hook loads the list and selects the first project.
- `reload` keeps the current selection.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useProjects } from './useProjects';
import { setApi } from './api';

function installApi(projects: unknown[]) {
  setApi({
    registerComponent: () => () => {},
    registerRoute: () => () => {},
    fetch: vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, body: { projects } }),
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

describe('useProjects', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('selects the first project after the load', async () => {
    installApi([
      { id: 'p_1', name: 'Alpha', cardCount: 1 },
      { id: 'p_2', name: 'Beta', cardCount: 0 },
    ]);
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(result.current.selected).toBe('p_1');
  });

  it('keeps the current selection across a reload', async () => {
    installApi([{ id: 'p_1', name: 'Alpha', cardCount: 1 }]);
    const { result } = renderHook(() => useProjects());
    await waitFor(() => expect(result.current.selected).toBe('p_1'));
    act(() => result.current.setSelected('p_9'));
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.selected).toBe('p_9');
  });
});
```

## Step 10 — Add the select test [agent: test]

**New file**: `drone-swarm-project/bundle/ProjectSelect.test.tsx`

Cover:

- The list renders, and the sentinel is the last option.
- A pick of the sentinel calls `onNewProject` and does **not** call `onChange`.

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectSelect } from './ProjectSelect';

const projects = [
  { id: 'p_1', name: 'Alpha', cardCount: 2 },
  { id: 'p_2', name: 'Beta', cardCount: 0 },
];

describe('ProjectSelect', () => {
  it('renders the projects and the sentinel last', () => {
    render(
      <ProjectSelect
        projects={projects}
        value="p_1"
        onChange={() => {}}
        onNewProject={() => {}}
      />
    );
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveTextContent('Alpha');
    expect(options[options.length - 1]).toHaveTextContent('New Project…');
  });

  it('calls onNewProject and not onChange for the sentinel', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onNewProject = vi.fn();
    render(
      <ProjectSelect
        projects={projects}
        value="p_1"
        onChange={onChange}
        onNewProject={onNewProject}
      />
    );
    await user.selectOptions(screen.getByRole('combobox'), '__new_project__');
    expect(onNewProject).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('calls onChange for a real project', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ProjectSelect
        projects={projects}
        value="p_1"
        onChange={onChange}
        onNewProject={() => {}}
      />
    );
    await user.selectOptions(screen.getByRole('combobox'), 'p_2');
    expect(onChange).toHaveBeenCalledWith('p_2');
  });
});
```

## Step 11 — Add the modal tests [agent: test]

**New file**: `drone-swarm-project/bundle/ProjectModal.test.tsx`

Cover:

- **Create mode.** The name is empty. The first beacon is preselected. The working directory seeds from the beacon.
- **Create mode.** Submit sends `project.create` with the three fields, and calls `onSaved`.
- **Create mode.** A failed reply shows the inline error and stays open.
- **Create mode.** With no connected beacon, name-only create works.
- **Edit mode.** The form seeds from the project, including a stored offline beacon.
- **Edit mode.** Submit sends `project.update` with `projectId`.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProjectModal } from './ProjectModal';
import { setApi } from './api';
import type { Project } from './types';

function installApi(options: {
  beacons?: unknown[];
  extensions?: unknown[];
  actionReply?: unknown;
}) {
  const fetchImpl = vi.fn(async (path: string) => {
    if (String(path).includes('/api/beacons')) {
      return {
        ok: true,
        json: async () => options.beacons ?? [],
      } as unknown as Response;
    }
    if (String(path).includes('/api/extensions')) {
      return {
        ok: true,
        json: async () => options.extensions ?? [],
      } as unknown as Response;
    }
    return {
      ok: true,
      json: async () => options.actionReply ?? { ok: true, body: {} },
    } as unknown as Response;
  });
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

const expandedProject: Project = {
  id: 'p_1',
  name: 'Alpha',
  columns: [],
  cards: [],
  defaultBeaconId: 'b_gone',
  defaultWorkingDir: '/srv/gone',
};

describe('ProjectModal', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('creates a project with the selected beacon and root', async () => {
    const user = userEvent.setup();
    const fetchImpl = installApi({
      beacons: [
        {
          id: 'b_1',
          name: 'Beacon One',
          connected: true,
          spawnRoots: ['/srv/a'],
          defaultSpawnRoot: '/srv/a',
        },
      ],
      actionReply: { ok: true, body: { project: { id: 'p_new', name: 'X' } } },
    });
    const onSaved = vi.fn();
    render(<ProjectModal mode="create" onClose={() => {}} onSaved={onSaved} />);
    await user.type(screen.getByLabelText('Name'), 'Gamma');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const call = fetchImpl.mock.calls.find(call =>
      String(call[0]).includes('project.create')
    );
    const sent = JSON.parse(String((call![1] as RequestInit).body));
    expect(sent.params.name).toBe('Gamma');
    expect(sent.params.defaultBeaconId).toBe('b_1');
    expect(sent.params.defaultWorkingDir).toBe('/srv/a');
  });

  it('removes extension nodes from the beacon picker', async () => {
    installApi({
      beacons: [
        { id: 'b_ext', name: 'Ext', connected: true, spawnRoots: [] },
        { id: 'b_1', name: 'Beacon One', connected: true, spawnRoots: [] },
      ],
      extensions: [{ nodeId: 'b_ext', connected: true, isExtension: true }],
    });
    render(
      <ProjectModal mode="create" onClose={() => {}} onSaved={() => {}} />
    );
    expect(
      await screen.findByRole('option', { name: 'Beacon One' })
    ).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Ext' })).toBeNull();
  });

  it('shows a stored offline beacon in edit mode', async () => {
    installApi({ beacons: [], extensions: [] });
    render(
      <ProjectModal
        mode="edit"
        project={expandedProject}
        onClose={() => {}}
        onSaved={() => {}}
      />
    );
    expect(
      await screen.findByRole('option', { name: 'b_gone (offline)' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: '/srv/gone' })
    ).toBeInTheDocument();
  });

  it('sends project.update with projectId in edit mode', async () => {
    const user = userEvent.setup();
    const fetchImpl = installApi({
      beacons: [],
      actionReply: { ok: true, body: { project: expandedProject } },
    });
    const onSaved = vi.fn();
    render(
      <ProjectModal
        mode="edit"
        project={expandedProject}
        onClose={() => {}}
        onSaved={onSaved}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const call = fetchImpl.mock.calls.find(call =>
      String(call[0]).includes('project.update')
    );
    const sent = JSON.parse(String((call![1] as RequestInit).body));
    expect(sent.params.projectId).toBe('p_1');
  });

  it('shows an inline error and stays open on failure', async () => {
    const user = userEvent.setup();
    installApi({
      beacons: [],
      actionReply: { ok: false, status: 400, body: { error: 'bad name' } },
    });
    const onSaved = vi.fn();
    render(<ProjectModal mode="create" onClose={() => {}} onSaved={onSaved} />);
    await user.type(screen.getByLabelText('Name'), 'Z');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('bad name')).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
```

**Note for the executor.** `getByLabelText('Name')` needs the label text to wrap the input. The `dsp-field` label wraps the input, so the association holds. If it does not, use `screen.getByRole('textbox')`.

## Step 12 — Add the board-page tests [agent: test]

**File**: `drone-swarm-project/bundle/BoardPage.test.tsx`

Add these cases. Keep the two existing cases.

- A pick of `New Project…` opens the modal (the `Create` button appears).
- The `Edit Project` button is disabled when there is no project.
- With zero projects, the empty hint and the `New Project` button appear.

The `installApi` mock must answer `/api/beacons` and `/api/extensions` with `ok: true` and `json: async () => []`, because the modal fetches them. Update the mock.

## Step 13 — Documentation [agent: code]

1. **New ADR**: `docs/adr/275-kanban-project-create-and-edit-ui.md`.

   Content:
   - **Context.** The board bundle can move and edit cards, but it cannot create or edit a project. The `project.create` and `project.update` capabilities exist and are `ui`-tier. No UI code calls them. A project carries `defaultBeaconId` and `defaultWorkingDir` that automations inherit; nothing can override them yet.
   - **Decision.**
     - **D1** the project dropdown on both pages gains a `New Project…` sentinel (`__new_project__`); the sentinel never becomes the selection.
     - **D2** the New Project modal has Name (required), Beacon, and Working directory.
     - **D3** the Beacon picker lists connected beacons.
     - **D4** the Working-directory picker lists the selected beacon's `spawnRoots`, seeded `defaultSpawnRoot ?? spawnRoots[0]`, re-seeded on a beacon change.
     - **D5** extension nodes are removed from the beacon picker, using `isExtension` from `GET /api/extensions`.
     - **D6** with no connected beacon, a name-only project can be created.
     - **D7** after a create, the new project is selected, the modal closes, and the list reloads.
     - **D8** edit is a separate `Edit Project` button on the board page, acting on the current selection; delete is deferred.
     - **D9** one `ProjectModal` serves both modes through a `mode` prop.
     - **D10** a stored beacon or working directory that is not in the live list is shown, annotated, and preselected; it is never silently rewritten.
     - **D11** a shared `ProjectSelect` and a shared `useProjects()` hook replace the duplicated dropdown and list logic.
   - **Consequences.** The UI can now call `project.create` and `project.update`. The settings-panel sentinel navigates to the board page, so one modal lives in one place. `project.update` treats an empty `defaultWorkingDir` as "no change", so the modal cannot clear it; the handler is unchanged.
   - **Does not amend** an earlier ADR. It extends ADR 271 and follows ADR 274.

2. **Index row**: add a row for 275 at the top of `docs/adr/index.md`. Run the duplicate check:

   ```bash
   ls docs/adr | grep -E '^[0-9]{3}-' | sed 's/-.*//' | sort | uniq -d   # must be empty
   sed -n '1,3p' docs/adr/index.md                                       # no prose above the table
   ```

   **Known pre-existing defect.** The index has duplicated rows and missing rows. It is tracked as project memory `followup-adr-index-duplicate-rows-and-missing-entries`. Do not repair the index in this plan. Add the one 275 row.

3. **Agent docs**: in `docs/agents/drone-swarm-project.md`, add a "Project create and edit" section. Describe the sentinel, the modal, the fields, the extension-node exclusion, and the shared components. Reference ADR 275.

4. **Package README**: in `drone-swarm-project/README.md`, add a short note under "What it does" about the create/edit UI.

5. **Glossary**: in `drone-swarm-project/CONTEXT.md`, extend the **Project** term with the two default fields if they are not there.

6. **Obsidian wiki** (vault at `/home/unleet/Obsidian/drone-agent-project`):
   - Add a pointer stub `decisions/275-kanban-project-create-and-edit-ui.md`, with the same shape as `decisions/274-card-modal-and-drone-ui-error-api.md`.
   - Add the 275 row to `decisions/index.md`.
   - In `modules/drone-swarm-project.md`, add a note about project create/edit.
   - Append an entry to `log.md`, and update `meta.json`.

## Step 14 — Check the work against the validation criteria [agent: test]

Run every command in section 4. Do not mark the work done until all pass.

---

## 4. Validation criteria

All of these must pass.

1. **LSP** — no errors or warnings on every changed file: `drone-swarm-project/bundle/types.ts`, `api.ts`, `beacons.ts`, `useProjects.ts`, `ProjectSelect.tsx`, `ProjectModal.tsx`, `BoardPage.tsx`, `BoardSettings.tsx`, `styles.css`, and the test files.
2. **Build** — `pnpm -r run build` exits 0. This compiles the bundle with esbuild. A missing or broken bundle fails this step.
3. **Typecheck** — `pnpm typecheck` exits 0. This includes the bundle's two tsconfigs.
4. **Lint** — `pnpm run lint` exits 0 (eslint, then prettier). Prettier reformats files. So re-read every file before a later edit.
5. **Fast test suite** — `pnpm test` passes.
6. **Bundle tests** — `pnpm --filter drone-swarm-project test:ui` passes.
7. **Regression proof** — the new bundle tests fail before Steps 1 to 8, and pass after. Prove it with file backups in `/tmp`. Do **not** use `git stash`. On this host a `git stash push` with a non-matching pathspec exits 0 and stashes nothing. A chained `stash pop` then grabs the wrong stash.
8. **Behavior** (manual, or covered by tests):
   - The `New Project…` option is last in the dropdown on both pages.
   - A pick of `New Project…` opens the modal and does not change the selection.
   - The modal lists connected beacons only. Extension nodes are absent.
   - The working directory re-seeds when the beacon changes.
   - A create selects the new project, closes the modal, and reloads the list.
   - The `Edit Project` button is disabled with no selection.
   - Edit seeds the form from the project. A stored offline beacon shows and is preselected.
   - A failed save shows the inline error and keeps the modal open.
   - With zero projects, the board shows the hint and the `New Project` button.
9. **No server change** — `drone-swarm-project/src/capabilities.ts`, `src/handlers.ts`, and `src/store/**` are unchanged. `pnpm --filter drone-swarm-project test` stays green.
10. **Docs** — ADR 275 exists, the index row is present, and the agent doc is updated.
11. **Memory committed** — the new project memory and any insights are committed on `feat/kanban-extension-base`, not `main`.

## 5. Out of scope

- **Project delete.** No UI for it. The `project.delete` capability exists but stays unused.
- **Per-automation beacon and working-directory override.** Still reserved.
- **Clearing a project default.** `project.update` ignores an empty value. The handler is unchanged.
- **A fix to `NewSessionPanel`.** It has the same extension-node bug in its beacon list. It is noted, not fixed here.
- **Repair of the `docs/adr/index.md` duplicates.** Tracked as a separate followup.

---

## Execution summary (2026-11-10, branch `feat/kanban-extension-base`)

**Status: COMPLETE.** All 14 steps executed. Commit `80043465` (code) plus the docs/memory commit.

### What was done

- **Steps 1–4 (bundle modules):** `types.ts` gained `defaultBeaconId`/`defaultWorkingDir` on `Project` plus `BeaconRow`/`ExtensionRow`; `api.ts` gained `apiFetch`/`apiNavigate`; new `beacons.ts` (`loadPickerBeacons`, filters `connected` and drops extension nodes); new `useProjects.ts` (`NEW_PROJECT_VALUE = '__new_project__'`, `current ?? first` selection); new `ProjectSelect.tsx`; new `ProjectModal.tsx` (create→`project.create`, edit→`project.update`, offline beacon/root annotated and preserved).
- **Step 5:** `styles.css` gained `.dsp-empty-hint`.
- **Step 6:** `BoardPage.tsx` rewritten to use `useProjects`/`ProjectSelect`/`ProjectModal`, added the `Edit Project` button (disabled with no selection) and the zero-projects hint.
- **Step 7:** `BoardSettings.tsx` rewritten to use the shared `ProjectSelect`; the sentinel calls `apiNavigate('/board')`.
- **Steps 8–12 (tests):** board-page mock now answers `/api/beacons` and `/api/extensions`; new `useProjects.test.tsx`, `ProjectSelect.test.tsx`, `ProjectModal.test.tsx`; `BoardPage.test.tsx` gained sentinel/disabled-edit/empty-hint cases. Bundle suite: 20/20.
- **Step 13 (docs):** new ADR 275 + `docs/adr/index.md` row; `docs/agents/drone-swarm-project.md` "Project create and edit" section; README "What it does" item 6; `CONTEXT.md` Project term extended; Obsidian wiki (pointer stub `decisions/275-...`, decisions index row, module-page update note, `log.md` entry, `index.md` count→275, `meta.json` checkpoint).

### Validation (Step 14)

- LSP clean. `pnpm -r run build`, `pnpm typecheck`, `pnpm run lint` all exit 0.
- Fast suite: 4706 passed / 19 skipped. Bundle suite: 20/20.
- **Regression proof** (file backups in `/tmp`, not `git stash`): with pre-change bundle sources + the new tests, 4 test files fail (3 fail to import the new modules; BoardPage's new cases fail). Restored to identical post-change state.
- **No server change:** `drone-swarm-project/src/**` untouched.

### Gaps the plan did not list (fixed during execution)

1. `apply_diff` could not rewrite `BoardPage.tsx`/`BoardSettings.tsx` (change zones too generic); used a full `file__write` rewrite instead.
2. **Bundle-test mock trap:** the action endpoint is `POST /api/extensions/<nodeId>/actions/<name>`, so a mock matching `path.includes('/api/extensions')` wrongly catches **every** action call. The `/api/beacons` and `/api/extensions` REST reads must match on `path.endsWith(...)`. This surfaced as `project.create` resolving to the wrong mock reply (`Save failed (HTTP undefined)`).
3. The `ProjectModal.test.tsx` mock needed a second `_init?: RequestInit` parameter so the `mock.calls` tuple exposes the request body (TS2493/TS2352 under the bundle's `tsconfig.test.json`).
4. Lint `no-useless-assignment`: `ProjectSelect.tsx` declared `const React = globalThis.React` but used no hooks/JSX factory reference; removed.

### Out of scope (unchanged)

Project delete; per-automation beacon/working-dir override; clearing a project default (`project.update` ignores an empty value); the `NewSessionPanel` extension-node bug; `docs/adr/index.md` duplicate-row repair.
