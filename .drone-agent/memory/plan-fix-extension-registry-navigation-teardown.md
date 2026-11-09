---
key: plan-fix-extension-registry-navigation-teardown
tags:
  - plan
  - drone-coordinator-ui
  - swarm-extension
  - routing
  - bug-fix
  - error-boundary
  - react
  - ADR-273
created: 2026-11-09T22:27:14.773Z
updated: 2026-11-09T22:27:14.773Z
---

# Plan — Fix the extension registry teardown and add a UI error boundary

**Status**: Ready for execution. Branch `feat/kanban-extension-base`.
**Executor**: persona `code`. One reviewer pass at the end.

## 1. Summary — what and why

The coordinator web UI shows a "Board" navigation item for the
`drone-swarm-project` kanban extension. The item is styled correctly. But when
the user clicks it, the app returns to `/` and the item disappears. No message
appears in the console.

The cause is **not** the board bundle. The cause is **not** an empty project
list.

The cause is this: the extension registry is **torn down on every navigation,
and it is never rebuilt**. The chain is:

1. `useNavigate()` from react-router 7.18.3 returns a function whose identity
   changes when the path changes. Its `useCallback` depends on
   `locationPathname` (see
   `node_modules/.pnpm/react-router@7.18.3_*/node_modules/react-router/dist/development/chunk-BV7QT456.mjs:5994`).
2. `useExtensions` builds `load` as `useCallback(..., [authFetch, navigate])`
   (`drone-coordinator-ui/src/extensions/useExtensions.tsx`). So the identity of
   `load` changes on every navigation.
3. `ExtensionProvider`'s effect depends on `extensions.load`
   (`drone-coordinator-ui/src/extensions/ExtensionContext.tsx`). So the effect
   runs again on every navigation.
4. The effect cleanup calls every disposer. This removes the `/board` route and
   every region component from the registry.
5. The effect runs again and calls `load`. But `didLoadRef.current` is already
   `true`. So `load` returns an empty disposer array at once and registers
   nothing.

Result: `/board` leaves the route table. The catch-all
`ExtensionRouteFallback` then runs with `loading === false` and redirects to
`/`. At the same time, the host-drawn "Board" link disappears, because it is
rendered from `pluginRoutes`. Both symptoms, one cause. It is deterministic.

The teardown is silent by design. Cleanup is not an error path. So nothing
throws and nothing logs.

ADR 272 (`docs/adr/272-extension-routes-first-class-nav.md`) did not catch this,
because `App.test.tsx` renders once at `/board` and never navigates.

This plan does three things:

1. Make `load` reference-stable. Then the provider effect runs only at mount.
2. Make disposal robust (a persistent ref), so the effect cleanup and the React
   StrictMode double-invoke cannot lose registrations.
3. Add a React error boundary, so a future render crash shows a visible panel
   and writes to the console, instead of a silent blank area.

## 2. Decisions (locked with the user)

- **D1 — Fix mechanism.** Hold `navigate` and `authFetch` in refs inside
  `useExtensions`. Then `load` is `useCallback(..., [])`. The provider effect
  becomes mount-only.
- **D2 — Diagnosability.** Add a reusable React `ErrorBoundary` (a class
  component). It shows a visible error panel and calls `console.error`.
- **D3 — Disposal rigor.** The provider pushes each disposer into a **persistent
  ref**, and the cleanup disposes the ref and then clears it. Do **not** use a
  `cancelled` boolean flag. A `cancelled` flag breaks React StrictMode: the
  simulated unmount sets the flag, `didLoadRef` prevents re-registration, and a
  late registration would be disposed at once. The ref-reset form is
  StrictMode-safe: the simulated unmount disposes an as-yet-empty ref, the late
  registration lands in the fresh ref, and the real unmount disposes it.
- **D4 — Boundary placement.** One boundary around `<Routes>` inside `<main>`,
  keyed by `useLocation().pathname`. The sidebar stays usable for recovery. A
  second outer boundary is deferred.
- **D5 — Panel content.** A centered panel in the house `ErrorBanner` style:
  the heading "Something went wrong", the caught message, and a "Try again"
  button that resets the boundary. The component stack goes to `console.error`.
- **D6 — Tests.** Three tests: an App-level navigation regression, an
  `ErrorBoundary` unit test, and a `useExtensions` load-stability unit test.
- **D7 — Docs.** A new ADR 273 plus its index row, a sentence in
  `docs/agents/swarm-extensions.md`, and the Obsidian wiki stub plus module
  note.

**No change to `drone-swarm-project`.** No bundle rebuild. The bug is entirely
host-side.

## 3. Execution order and dependencies

- Step 1 and Step 2 are both in the extension host. Do Step 1 first. Step 2
  depends on Step 1 for the mount-only effect.
- Step 3 then Step 4 (the boundary must exist before it is wired in).
- Step 5 (tests) after Steps 1–4.
- Step 6 (docs) after the code is final.
- Step 7 (validation) last.

---

## Step 1 — Stabilize `load` [agent: code]

**File**: `drone-coordinator-ui/src/extensions/useExtensions.tsx`

Hold `authFetch` and `navigate` in refs. Keep the refs fresh in a `useEffect`.
Set the `load` dependency list to `[]`. Read the refs inside `load`.

Replace the file body with this:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PluginClientRoute, UIRegion } from './types';
import { loadExtensionBundles, defaultInjectStylesheet } from './loader';
import { useAuthenticatedFetch } from '@/hooks/use-auth';

/**
 * Loads the coordinator's extension bundles once and returns a `load` function
 * that hands each bundle's contributions to the registry callbacks. The heavy
 * lifting lives in the pure `loadExtensionBundles` so it is unit-testable
 * without a real dynamic `import()`.
 *
 * `load` MUST be reference-stable. The provider's effect depends on it, so an
 * unstable `load` re-runs that effect on every navigation and disposes the
 * whole registry. `navigate` (and `authFetch`) therefore live in refs, not in
 * the `useCallback` dependency list.
 */

export interface ExtensionsLoader {
  /** Load all bundles; returns disposers for everything registered. */
  load: (
    registerComponent: (
      region: UIRegion,
      component: unknown,
      label?: string
    ) => () => void,
    registerRoute: (route: PluginClientRoute) => () => void
  ) => Array<() => void>;
  loaded: string[];
  /** True until the bundle load settles (success or failure). */
  loading: boolean;
}

export function useExtensions(): ExtensionsLoader {
  const authFetch = useAuthenticatedFetch();
  const navigate = useNavigate();
  const loadedRef = useRef<string[]>([]);
  const didLoadRef = useRef(false);
  const [loading, setLoading] = useState(true);

  const authFetchRef = useRef(authFetch);
  const navigateRef = useRef(navigate);
  useEffect(() => {
    authFetchRef.current = authFetch;
    navigateRef.current = navigate;
  }, [authFetch, navigate]);

  const load = useCallback(
    (
      registerComponent: (
        region: UIRegion,
        component: unknown,
        label?: string
      ) => () => void,
      registerRoute: (route: PluginClientRoute) => () => void
    ): Array<() => void> => {
      const disposers: Array<() => void> = [];
      if (didLoadRef.current) return disposers;
      didLoadRef.current = true;

      void (async () => {
        try {
          let entries: Parameters<typeof loadExtensionBundles>[0];
          try {
            const res = await authFetchRef.current('/api/extensions');
            if (!res.ok) return;
            entries = await res.json();
          } catch {
            return;
          }

          const result = await loadExtensionBundles(entries, {
            importModule: url => import(/* @vite-ignore */ url),
            registerComponent,
            registerRoute,
            injectStylesheet: defaultInjectStylesheet,
            fetch: (path, init) => authFetchRef.current(path, init),
            navigate: path => navigateRef.current(path),
          });
          disposers.push(...result.disposers);
          loadedRef.current = result.loaded;
        } finally {
          setLoading(false);
        }
      })();

      return disposers;
    },
    []
  );

  return useMemo(
    () => ({ load, loaded: loadedRef.current, loading }),
    [load, loading]
  );
}
```

**Test for this step**: the load-stability unit test (Step 5, test C) fails
before this change and passes after.

## Step 2 — Track disposers in the provider [agent: code]

**File**: `drone-coordinator-ui/src/extensions/ExtensionContext.tsx`

Add `useRef` to the `react` import. Add a `disposersRef`. Replace the provider
effect with the block below. The register callbacks now wrap the registry
callbacks, push the disposer into the ref, and return it.

```tsx
  const disposersRef = useRef<Array<() => void>>([]);
  const extensions = useExtensions();
  useEffect(() => {
    extensions.load(
      (region, component, label) => {
        const dispose = registerComponent(
          region as UIRegion,
          component as ComponentType,
          label
        );
        disposersRef.current.push(dispose);
        return dispose;
      },
      route => {
        const dispose = registerRoute(route);
        disposersRef.current.push(dispose);
        return dispose;
      }
    );
    if (extensions.loaded.length > 0) setLoaded(extensions.loaded);
    return () => {
      for (const dispose of disposersRef.current) dispose();
      disposersRef.current = [];
    };
  }, [extensions.load, registerComponent, registerRoute]);
```

Do **not** add a `cancelled` flag. See D3.

**Test for this step**: the App-level navigation regression (Step 5, test A).

## Step 3 — Add the ErrorBoundary [agent: code]

**New file**: `drone-coordinator-ui/src/components/error-boundary.tsx`

```tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: unknown;
}

/**
 * Catches a render error in its subtree and shows a visible fallback panel
 * instead of unmounting the whole app. `console.error` keeps the error and the
 * component stack in the browser console for diagnosis.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled UI error:', error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (error === null) {
      return this.props.children;
    }
    const message = error instanceof Error ? error.message : String(error);
    return (
      <div className="p-6">
        <div className="mx-auto max-w-lg rounded-md border border-destructive/30 bg-destructive/10 p-4 text-destructive">
          <h2 className="text-lg font-semibold">Something went wrong</h2>
          <p className="mt-1 text-sm break-words">{message}</p>
          <button
            type="button"
            onClick={this.handleRetry}
            className="mt-3 rounded-md border border-destructive/40 px-3 py-1.5 text-sm font-medium hover:bg-destructive/20"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
```

A React error boundary must be a class component. React has no hook form.

## Step 4 — Wire the boundary into App [agent: code]

**File**: `drone-coordinator-ui/src/App.tsx`

1. Add `useLocation` to the `react-router-dom` import.
2. Add `type ReactNode` to the `react` import.
3. Import the boundary:
   `import { ErrorBoundary } from '@/components/error-boundary';`
4. Add this component above `AppLayout`:

```tsx
function KeyedErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>;
}
```

5. Wrap `<Routes>` inside `<main>`:

```tsx
      <main className="flex-1 overflow-auto p-6">
        <KeyedErrorBoundary>
          <Routes>
            {/* ...existing routes unchanged... */}
          </Routes>
        </KeyedErrorBoundary>
      </main>
```

`KeyedErrorBoundary` must stay inside `<BrowserRouter>`, so it can call
`useLocation`. It already is, because `AppLayout` is inside the router.

The `key={location.pathname}` gives an automatic reset: when the user navigates
to another route, React remounts the boundary and the error clears.

## Step 5 — Tests [agent: test]

### Test A — App navigation regression (extend `drone-coordinator-ui/src/App.test.tsx`)

Add this case to the existing `describe('App extension routes', ...)` block. It
uses the real `useExtensions` and the real provider. Only the loader is mocked.
It fails before Step 1 and passes after.

```tsx
  it('keeps the extension route and its nav link after navigating to it', async () => {
    const user = userEvent.setup();
    window.history.pushState({}, '', '/');
    render(<App />);

    const link = await screen.findByRole('link', { name: /Board/ });
    await user.click(link);

    await waitFor(() => {
      expect(window.location.pathname).toBe('/board');
      expect(screen.getByText('BOARD')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /Board/ })).toBeInTheDocument();
  });
```

Add `import userEvent from '@testing-library/user-event';` to the test file.
`@testing-library/user-event` is already a devDependency.

### Test B — ErrorBoundary unit (new `drone-coordinator-ui/src/components/error-boundary.test.tsx`)

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ErrorBoundary } from './error-boundary';

let boom = true;

function Flaky() {
  if (boom) throw new Error('kaboom');
  return <div>SAFE</div>;
}

describe('ErrorBoundary', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    boom = true;
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('renders the fallback panel when a child throws', () => {
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('kaboom')).toBeInTheDocument();
    expect(errorSpy).toHaveBeenCalled();
  });

  it('recovers when "Try again" is clicked and the child no longer throws', async () => {
    const user = userEvent.setup();
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    boom = false;
    await user.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByText('SAFE')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });
});
```

### Test C — `load` reference stability (new `drone-coordinator-ui/src/extensions/useExtensions.test.tsx`)

This test proves the root cause. It fails before Step 1 and passes after.

```tsx
import { describe, it, expect } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter, useNavigate, useLocation } from 'react-router-dom';
import { AuthProvider } from '@/hooks/use-auth';
import { useExtensions } from './useExtensions';

function Probe({ onLoad }: { onLoad: (load: unknown) => void }) {
  const { load } = useExtensions();
  const navigate = useNavigate();
  useLocation();
  onLoad(load);
  return (
    <button type="button" onClick={() => navigate('/board')}>
      go
    </button>
  );
}

describe('useExtensions', () => {
  it('keeps the load reference stable across navigation', () => {
    const seen: unknown[] = [];
    render(
      <AuthProvider>
        <MemoryRouter initialEntries={['/']}>
          <Probe onLoad={load => seen.push(load)} />
        </MemoryRouter>
      </AuthProvider>
    );
    const first = seen[seen.length - 1];

    act(() => {
      document.querySelector('button')!.click();
    });

    const second = seen[seen.length - 1];
    expect(second).toBe(first);
  });
});
```

`Probe` calls `useLocation()` on purpose. It must re-render on navigation, so
the test can compare the two `load` identities. Do not remove it.

## Step 6 — Documentation [agent: code]

1. **New ADR**: `docs/adr/273-extension-registry-navigation-teardown.md`.
   Outline:
   - Context: ADR 272 made extension routes first-class, but a click on a
     host-rendered extension nav link still returned to `/` and removed the
     link. Root cause: `useNavigate()` identity changes per navigation, so
     `load` changes, so the provider effect re-runs and disposes the registry,
     and `didLoadRef` prevents re-registration.
   - Decision:
     - D1 `load` is reference-stable (refs for `navigate` and `authFetch`).
     - D2 the provider tracks disposers in a persistent ref; cleanup disposes
       and clears it. No `cancelled` flag (StrictMode).
     - D3 a reusable `ErrorBoundary` wraps `<Routes>`, keyed by pathname.
     - D4 the boundary shows a house-style panel with a "Try again" reset, and
       logs to `console.error`.
   - Consequences: extension routes and nav links survive navigation; a render
     crash shows a panel instead of a silent blank area; StrictMode dev runs no
     longer leak disposers.
   - Amends ADR 272 D7 and the provider contract.
2. **Index row**: add a row for 273 at the top of `docs/adr/index.md`, above the
   272 row. Then verify:
   ```bash
   ls docs/adr | grep -E '^[0-9]{3}-' | sed 's/-.*//' | sort | uniq -d   # must be empty
   grep -c '^| \[' docs/adr/index.md                                      # must match the file count
   sed -n '1,8p' docs/adr/index.md                                        # no prose above the table
   ```
3. **Agent docs**: in `docs/agents/swarm-extensions.md`, extend the
   "Extension routes load asynchronously" paragraph. State that the registry is
   mount-stable (the loader runs once) and that a render crash is caught by a
   boundary. Reference ADR 273.
4. **Obsidian wiki**:
   - Add a pointer stub `decisions/273-extension-registry-navigation-teardown.md`
     (same shape as `decisions/272-extension-routes-first-class-nav.md`).
   - In `modules/drone-coordinator-ui.md`, add a short note about the stable
     `load`, the provider disposal ref, and the new `ErrorBoundary`.

## Step 7 — Check the work against the validation criteria [agent: test]

Run every command in section 4. Do not mark the work done until all pass.

---

## 4. Validation criteria

All of these must pass.

1. **LSP** — no errors or warnings on every changed file
   (`useExtensions.tsx`, `ExtensionContext.tsx`, `App.tsx`,
   `error-boundary.tsx`, and the three test files).
2. **Build** — `pnpm -r run build` exits 0.
3. **Typecheck** — `pnpm typecheck` exits 0.
4. **Lint** — `pnpm run lint` exits 0 (eslint, then prettier). Prettier
   reformats files, so re-read every file before a later edit.
5. **Fast test suite** — `pnpm test` passes.
6. **UI package tests** — `pnpm --filter drone-coordinator-ui test` passes.
   This script sets `NODE_ENV=test`. A bare `npx vitest run` resolves react-dom
   to its production build, where `React.act` is undefined, and the UI tests
   fail with a false signal.
7. **Regression proof** — test A and test C fail on the current code, and pass
   after the fix.
8. **Behavior** (manual or covered by tests):
   - A full page load of `/board` shows the board.
   - A click on the "Board" link keeps the path at `/board`, shows the board,
     and keeps the "Board" link in the sidebar.
   - A child that throws renders the error panel, and "Try again" recovers.
   - The error and the component stack reach `console.error`.
9. **ADR integrity** — the three commands in Step 6 item 2 report no duplicate
   numbers, a matching row count, and no prose above the table.
10. **Bundle untouched** — `drone-swarm-project/dist/bundle/index.js` is
    unchanged. No rebuild is needed.
11. **Memory committed** — the new project memory and any insights are
    committed on `feat/kanban-extension-base` (not `main`).

## 5. Out of scope

- A second outer error boundary over the whole app shell (deferred).
- A dev-mode `console.warn` tripwire when the registry is disposed by a re-run
  (the fix removes the re-run).
- A user-managed extension nav list (deferred in ADR 272).
- The `loaded` field of the registry (it is read from a ref and is always `[]`;
  not consumed by any page).
