---
key: plan-fix-extension-route-redirect-and-nav
tags:
  - plan
  - drone-coordinator-ui
  - extensions
  - bug-fix
  - routing
created: 2026-11-09T21:18:27.257Z
updated: 2026-11-09T21:18:27.257Z
---

# Plan: fix the `/board` redirect and make extension routes first-class

## 1. What this feature is, and why we do it

The kanban extension (`drone-swarm-project`) sends a front-end bundle to the
coordinator UI. The bundle declares a client route at `/board`. When a user
opens `/board`, the app sends the user back to `/`. The board never shows.

The cause is a load race in the coordinator UI. The app builds the route table
at the first render. Extension routes arrive later, because they come from an
async bundle load. Until they arrive, `/board` matches the catch-all route:

```tsx
<Route path="*" element={<Navigate to="/" replace />} />
```

The `Navigate` effect runs at commit time. The bundle load finishes much later.
So the redirect always wins. The redirect is deterministic.

`mcp-swarm` (the only other bundle) declares no routes. It declares only
regions. So no test ever exercised this path before `drone-swarm-project`.

This plan does four things:

1. Gate the catch-all. It waits for extensions to settle before it redirects.
2. Make the host render one sidebar nav link per extension route.
3. Add `navigate(path)` to the bundle API, so bundles navigate client-side.
4. Remove the hand-made nav link from the kanban bundle.

Items 2 and 3 make the extension route a first-class route. They remove the
full page reload on every sidebar click. They also remove the off-brand
styling of the bundle nav link.

## 2. Locked design decisions

- **D1** — The catch-all is gated, not removed. A "not-yet-known route" must
  not redirect while extensions load.
- **D2** — While extensions load, the catch-all shows a `Skeleton` placeholder.
  Use the same look as the other pages in this repo.
- **D3** — The gate wraps only the `path="*"` element. Core routes
  (`/sessions`, `/wiki`, and the others) must still render at once.
- **D4** — The host renders one `NavLink` per registered extension route. It
  uses `route.title` for the label. It uses the same classes and the same
  `isActive` logic as the core nav items.
- **D5** — `UIExtensionApi` gains `navigate(path)`. Bundles use it for
  client-side navigation. It has the same shape as the existing `api.fetch`.
- **D6** — The kanban bundle drops `BoardNav.tsx` and its `sidebar-nav`
  registration. Otherwise two "Board" links appear.
- **D7** — Write ADR 272. It amends ADR 254 D7/D11.

## 3. Steps

Each step names the agent type, the files, and the dependencies.

### Step 1 — Add `navigate` to the shared bundle API

- Agent: coder
- Depends on: nothing
- File: `drone-extension-ui-types/src/index.ts`

In `UIExtensionApi`, add this member after `fetch`:

```ts
  /** Navigate to a client route without a page reload. */
  navigate: (path: string) => void;
```

### Step 2 — Rebuild the workspace

- Agent: coder
- Depends on: Step 1

Run `pnpm -r run build`.

`drone-coordinator-ui` reads `drone-extension-ui-types` from its built
`dist/`. Typecheck in the UI fails on stale types until you rebuild.

### Step 3 — Thread `navigate` through the bundle loader

- Agent: coder
- Depends on: Step 1, Step 2
- File: `drone-coordinator-ui/src/extensions/loader.ts`

Add to `LoaderDeps`:

```ts
  /** Client-side navigation handed to bundles via `api.navigate`. */
  navigate: (path: string) => void;
```

Change `makeApi` to take a `navigate` argument. Add it to the returned object:

```ts
function makeApi(
  registerComponent: LoaderDeps['registerComponent'],
  registerRoute: LoaderDeps['registerRoute'],
  fetchImpl: LoaderDeps['fetch'],
  navigate: LoaderDeps['navigate']
): UIExtensionApi {
  return {
    registerComponent: (region, component) =>
      registerComponent(region, component),
    registerRoute,
    fetch: fetchImpl,
    navigate,
  };
}
```

Pass `deps.navigate` into `makeApi` at the `onReady` call site.

### Step 4 — Make the loader's loading state reactive

- Agent: coder
- Depends on: Step 3
- File: `drone-coordinator-ui/src/extensions/useExtensions.tsx`

Do these changes:

1. Import `useNavigate` from `react-router-dom`.
2. Add `const navigate = useNavigate();` inside the hook.
3. Add `const [loading, setLoading] = useState(true);`.
4. Add `loading: boolean;` to the `ExtensionsLoader` interface.
5. Pass `navigate` into the `loadExtensionBundles` deps object.
6. Wrap the async body in `try { ... } finally { setLoading(false); }`. The
   `finally` block must always run. It runs on a failed fetch and on a
   rejected import.
7. Add `loading` to the `useMemo` return value and to its dependency list.

Sketch:

```ts
const navigate = useNavigate();
const [loading, setLoading] = useState(true);
...
void (async () => {
  try {
    let entries: Parameters<typeof loadExtensionBundles>[0];
    try {
      const res = await authFetch('/api/extensions');
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
      fetch: (path, init) => authFetch(path, init),
      navigate,
    });
    disposers.push(...result.disposers);
    loadedRef.current = result.loaded;
  } finally {
    setLoading(false);
  }
})();
...
return useMemo(
  () => ({ load, loaded: loadedRef.current, loading }),
  [load, loading]
);
```

### Step 5 — Publish `loading` and add the route fallback

- Agent: coder
- Depends on: Step 4
- File: `drone-coordinator-ui/src/extensions/ExtensionContext.tsx`

Do these changes:

1. Add imports:

```ts
import { Navigate } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
```

2. Add `loading: boolean;` to `ExtensionRegistry`.
3. Add `loading: false,` to `EMPTY_REGISTRY`.
4. Pass `loading` into the context value, from `extensions.loading`.
5. Add this exported component at the end of the file:

```tsx
/**
 * The catch-all element. While extension bundles load, an extension route is
 * not yet in the route table. Show a placeholder and do not redirect. After
 * the load settles, an unknown path goes to the topology page.
 */
export function ExtensionRouteFallback() {
  const { loading } = useExtensionRegistry();
  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
    );
  }
  return <Navigate to="/" replace />;
}
```

### Step 6 — Wire the app: router order, catch-all, sidebar nav

- Agent: coder
- Depends on: Step 5
- File: `drone-coordinator-ui/src/App.tsx`

Do these changes:

1. Move `<BrowserRouter>` above `<ExtensionProvider>`. `useExtensions` calls
   `useNavigate` now, so `ExtensionProvider` must sit inside the router. New
   nesting:

```tsx
<ToastProvider>
  <AuthProvider>
    <WebSocketProvider>
      <BrowserRouter>
        <ExtensionProvider>
          <AppLayout />
        </ExtensionProvider>
      </BrowserRouter>
    </WebSocketProvider>
  </AuthProvider>
</ToastProvider>
```

2. Import `ExtensionRouteFallback` from `@/extensions/ExtensionContext`.
3. Replace the catch-all element:

```tsx
<Route path="*" element={<ExtensionRouteFallback />} />
```

4. In the sidebar `<nav>`, after the `navItems.map(...)` block and before
   `<RegionSlot region="sidebar-nav" />`, render one nav link per extension
   route:

```tsx
{pluginRoutes.map(route => (
  <NavLink
    key={route.path}
    to={route.path}
    className={({ isActive }) =>
      cn(
        'flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors',
        isActive
          ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
          : 'hover:bg-sidebar-accent/50 text-sidebar-foreground/80'
      )
    }
  >
    <span className="text-base">◧</span>
    {route.title}
  </NavLink>
))}
```

### Step 7 — Stop the kanban bundle from drawing its own nav link

- Agent: coder
- Depends on: Step 6
- Files: `drone-swarm-project/bundle/index.tsx`,
  `drone-swarm-project/bundle/BoardNav.tsx`

Do these changes:

1. In `bundle/index.tsx`, delete the `BoardNav` import line.
2. In `bundle/index.tsx`, change the `regions` line to:

```tsx
  regions: { 'settings-panel': BoardSettings },
```

3. Delete the file `drone-swarm-project/bundle/BoardNav.tsx`.

Keep `routes`, `BoardPage`, `BoardSettings`, and `onReady` as they are.

### Step 8 — Rebuild the bundle

- Agent: coder
- Depends on: Step 7

Run `pnpm --filter drone-swarm-project run build`.

The bundle build reads `bundle/index.tsx` with esbuild. The old
`dist/bundle/index.js` still holds the `BoardNav` code until you rebuild.

### Step 9 — Update the tests

- Agent: tester
- Depends on: Step 8

Do these changes:

1. `drone-coordinator-ui/src/extensions/loader.test.ts`
   - Add `navigate: vi.fn(),` to the `deps()` helper.
   - Add a case. Assert that the injected `navigate` reaches bundles as
     `api.navigate`. Copy the shape of the existing `api.fetch` case.

2. `drone-coordinator-ui/src/extensions/ExtensionContext.test.tsx`
   - The `vi.mock('./useExtensions', ...)` factory must return
     `{ load: () => [], loaded: [], loading: false }`.
   - The test renders `ExtensionProvider` with no router today. `useExtensions`
     calls `useNavigate` now. Wrap the provider in `<MemoryRouter>`. Otherwise
     the test throws.

3. New file `drone-coordinator-ui/src/extensions/ExtensionRouteFallback.test.tsx`
   - Mock `./useExtensions` with a mutable `loading` value.
   - Add a location probe that reads `useLocation().pathname`.
   - Case 1: `loading = true`, start at `/board`. Assert the skeleton shows and
     the path stays `/board`.
   - Case 2: `loading = false`, start at `/board`. Assert the path becomes `/`.

4. New file `drone-coordinator-ui/src/App.test.tsx`
   - This is the regression test for the reported bug.
   - Stub the global `WebSocket` (copy the stub in `pages/topology.test.tsx`).
   - Set the start URL with `window.history.pushState({}, '', '/board')`.
   - Mock the fetch for `/api/extensions` to return one entry with one bundle.
   - Mock the bundle module load so it resolves a default export with
     `routes: [{ path: '/board', title: 'Board', component: () => <h1>BOARD</h1> }]`.
   - Render `<App />`. Wait for the board heading. Assert the path is still
     `/board`. This test must fail before Step 6 and pass after.

### Step 10 — Write the docs

- Agent: coder
- Depends on: Step 6

Do these changes:

1. New file `docs/adr/272-extension-routes-first-class-nav.md`.
   - Status: Implemented.
   - Context: the `/board` redirect; the load race; `mcp-swarm` declared no
     routes.
   - Decision: gate the catch-all until bundles settle; host renders one
     sidebar nav link per route, from `route.title`; `UIExtensionApi` gains
     `navigate(path)`.
   - Add `related:` links to `254-swarm-extensions.md` and
     `271-drone-swarm-project-kanban-extension.md`.
2. Add the row for ADR 272 to `docs/adr/index.md`.
3. Update `docs/agents/swarm-extensions.md`, section "Front-end bundles".
   - Add `navigate` to the `{ regions?, routes?, onReady?(api) }` contract list.
   - Note that the host renders a sidebar nav link for each route, from
     `route.title`, and that a bundle must not draw its own.
4. Update `drone-swarm-project/README.md` line 26 and line 27. State that the
   host renders the sidebar entry for `/board`.

### Step 11 — Update the project wiki

- Agent: coder
- Depends on: Step 10

Update the wiki page `drone-coordinator-ui-frontend-extension-system-as-built`
with a new appended section. Record the contract change: `UIExtensionApi`
gains `navigate`, and the host renders extension nav from `route.title`.
Update the `drone-swarm-project` module page for the bundle change.

### Step 12 — Final validation

- Agent: tester
- Depends on: all other steps

Run the full validation list in section 4. Do not stop at the first pass. Fix
and re-run until every item passes.

### Step 13 — Record insights and commit

- Agent: coder
- Depends on: Step 12

Log an insight about the load race with `self-improvement__insight`. Commit
the plan memory, the insights, and the code. Commit them together. Do this
only when the branch is a named branch, as AGENTS.md requires.

## 4. Validation criteria

All of these must pass. Do not mark the work done until they do.

1. **LSP** — no errors in any changed file. Use the connected `typescript` LSP
   for the UI and the types package.
2. **Types and build** — `pnpm -r run build` passes with zero errors.
3. **Typecheck** — `pnpm typecheck` passes.
4. **Lint** — `pnpm run lint` passes with zero errors. Note: the linter runs
   Prettier. Re-read every file before you edit it again after a lint run.
5. **Unit tests** — `pnpm run test` passes. This includes the new
   `ExtensionRouteFallback.test.tsx` and `App.test.tsx`.
6. **Behaviour, defect fixed** — open `/board` in a full page load. The board
   shows. The app does not return to `/`.
7. **Behaviour, no regression** — open `/sessions` and `/wiki` in a full page
   load. Each page shows at once. Each page does not wait for the bundles.
8. **Behaviour, nav** — the sidebar shows one "Board" link. Its style matches
   the core nav links. A click on it does not reload the page.
9. **Behaviour, unknown path** — open a path that no route owns. The app goes
   to `/` after the bundles settle.
10. **Bundle rebuild** — `pnpm --filter drone-swarm-project run build` passes.
    The built `dist/bundle/index.js` holds no `BoardNav` code.
