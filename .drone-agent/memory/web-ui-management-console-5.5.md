---
key: web-ui-management-console-5.5
tags:
  []
created: 2026-07-22T02:38:17.823Z
updated: 2026-07-22T02:55:47.431Z
---

# Plan for 5.5: Web UI Management Console

## Summary

The drone-coordinator-ui currently has 6 read-only pages (Topology, Sessions, Session Detail, Personas, Skills, Wiki). 5.5 adds the "write" side — management actions, dedicated detail/edit pages, and infrastructure improvements (error handling, loading states, pagination, search, dark mode toggle, tests).

## Step-by-Step Plan

### Step 1: Infrastructure Improvements (Foundation)

**Files to modify:**
- `drone-coordinator-ui/src/hooks/use-auth.tsx` — Add error state to `useAuthenticatedFetch`
- `drone-coordinator-ui/src/lib/types.ts` — Add pagination types, search types
- `drone-coordinator-ui/src/index.css` — Add dark mode toggle class logic
- `drone-coordinator-ui/src/App.tsx` — Add dark mode toggle to sidebar, add new routes

**Details:**

1a. **Error handling**: Replace empty `catch {}` blocks with proper error state management. Create a reusable `useApi` hook or pattern that tracks `{ data, loading, error }` consistently across all pages.

1b. **Loading states**: Replace "Loading..." text with skeleton components. Create a reusable `Skeleton` component (or use shadcn's pattern).

1c. **Pagination**: Add `limit`/`offset` query params to list page fetches. Add "Load More" or page-number controls. The coordinator already supports `?limit=&offset=` on `/sessions` and `/sessions/:id/events`. For other endpoints (personas, skills, wiki, beacons), the coordinator returns all results — pagination can be client-side for now (slice the array) since these lists are typically small.

1d. **Search**: Add search input fields to list pages. For personas/skills, filter client-side. For wiki, use the existing `/wiki/search?q=` endpoint.

1e. **Dark mode toggle**: Add a toggle button in the sidebar footer. Toggle the `.dark` class on `<html>`. Persist preference in `localStorage`.

1f. **Tests**: Add vitest + testing-library setup. Add tests for:
   - `use-auth` hook
   - `use-websocket` hook
- Each page component (smoke tests + interaction tests)

**New files:**
- `drone-coordinator-ui/src/hooks/use-api.ts` — Reusable fetch hook with error/loading/data state
- `drone-coordinator-ui/src/components/ui/skeleton.tsx` — Skeleton component
- `drone-coordinator-ui/src/components/ui/input.tsx` — Input component (for search fields)
- `drone-coordinator-ui/src/components/ui/dialog.tsx` — Dialog component (for confirmations)
- `drone-coordinator-ui/vitest.config.ts` — Test config
- `drone-coordinator-ui/src/test-setup.ts` — Test setup

**Dependencies:** None (foundation for all other steps)

---

### Step 2: Topology Page — Management Actions

**Files to modify:**
- `drone-coordinator-ui/src/pages/topology.tsx`
- `drone-coordinator-ui/src/App.tsx` (add route)
- `drone-coordinator-ui/src/lib/types.ts` (add BeaconDetail type)

**New files:**
- `drone-coordinator-ui/src/pages/beacon-detail.tsx`

**Details:**

2a. **Beacon detail page** (`/beacons/:id`):
   - Fetch `GET /beacons/:id` for beacon info + trust status
   - Fetch `GET /beacons/:id/sessions` for sessions on this beacon
   - Fetch `GET /agents/location?beaconId=:id` for agents on this beacon
   - Show: beacon name, ID, host:port, trust status, TLS fingerprint, connected time, last heartbeat
   - Sessions table (reuse pattern from sessions page)
   - Agents list

2b. **Topology page enhancements**:
   - Make beacon cards clickable → navigate to `/beacons/:id`
   - Add "Approve" button on pending beacons → `POST /beacons/approve` with `{ approvalToken }`
   - Add "Reject" button on pending beacons → `POST /beacons/trust/:id/reject`
   - Add "Remove" button on approved beacons → `DELETE /beacons/trust/:id`
   - Confirmation dialogs for destructive actions

**API endpoints used:**
- `GET /beacons/:id` — exists
- `GET /beacons/:id/sessions` — exists
- `GET /agents/location?beaconId=` — exists
- `POST /beacons/approve` — exists
- `POST /beacons/trust/:id/reject` — exists
- `DELETE /beacons/trust/:id` — exists

**Dependencies:** Step 1 (infrastructure)

---

### Step 3: Sessions Page — Management Actions

**Files to modify:**
- `drone-coordinator-ui/src/pages/sessions.tsx`

**Details:**

3a. **Remote terminate**: Add "Terminate" button to each session row. Calls `DELETE /beacons/:id/sessions/:agentId` with `{ disconnectedAt: Date.now(), durationMs }`. Confirmation dialog before action.

3b. **Mark as processed**: Add "Process" button to finished sessions. Calls `POST /sessions/:id/process`. Add "Mark Processed" button to processing sessions. Calls `POST /sessions/:id/processed`.

3c. **Session status column**: Add a status badge column showing the session pipeline status (active/processing/processed/finished).

3d. **Pagination**: Add limit/offset controls. The coordinator already supports `?status=&sortBy=&limit=&offset=` on `GET /sessions`.

**API endpoints used:**
- `DELETE /beacons/:id/sessions/:agentId` — exists
- `POST /sessions/:id/process` — exists
- `POST /sessions/:id/processed` — exists
- `GET /sessions?status=&limit=&offset=` — exists

**Dependencies:** Step 1 (infrastructure)

---

### Step 4: Personas — Detail/Create/Edit/Delete Pages

**Files to modify:**
- `drone-coordinator-ui/src/pages/personas.tsx`
- `drone-coordinator-ui/src/App.tsx` (add routes)

**New files:**
- `drone-coordinator-ui/src/pages/persona-detail.tsx`
- `drone-coordinator-ui/src/pages/persona-editor.tsx` (shared by create + edit)

**Details:**

4a. **Persona list page enhancements**:
   - Add "New Persona" button → navigate to `/personas/new`
   - Make persona cards clickable → navigate to `/personas/:id`
   - Add "Delete" button on each card → `DELETE /personas/:id` with confirmation
   - Add search input (client-side filter by name/description)
   - Add pagination (client-side)

4b. **Persona detail page** (`/personas/:id`):
   - Fetch `GET /personas/:id`
   - Show: name, ID, scope, description, system prompt (in a code block or rendered markdown), created/updated dates
   - "Edit" button → navigate to `/personas/:id/edit`
   - "Delete" button → `DELETE /personas/:id` with confirmation, redirect to list

4c. **Persona editor page** (`/personas/new` and `/personas/:id/edit`):
   - Form fields: name (text), id (text, auto-generated from name on create), description (textarea), scope (select: coordinator), system prompt (large textarea/monaco editor)
   - On create: `POST /personas` with body, redirect to detail page
   - On edit: `PUT /personas/:id` with body, redirect to detail page
   - Validation: name required, id required (slug format), description required, system prompt required

**API endpoints used:**
- `GET /personas/:id` — exists
- `POST /personas` — exists
- `PUT /personas/:id` — exists
- `DELETE /personas/:id` — exists

**Dependencies:** Step 1 (infrastructure)

---

### Step 5: Skills — Detail/Create/Edit/Delete Pages

**Files to modify:**
- `drone-coordinator-ui/src/pages/skills.tsx`
- `drone-coordinator-ui/src/App.tsx` (add routes)

**New files:**
- `drone-coordinator-ui/src/pages/skill-detail.tsx`
- `drone-coordinator-ui/src/pages/skill-editor.tsx` (shared by create + edit)

**Details:**

5a. **Skill list page enhancements**:
   - Add "New Skill" button → navigate to `/skills/new`
   - Make skill cards clickable → navigate to `/skills/:id`
   - Add "Delete" button on each card → `DELETE /skills/:id` with confirmation
   - Add search input (client-side filter by name/description/trigger)
   - Add pagination (client-side)

5b. **Skill detail page** (`/skills/:id`):
   - Fetch `GET /skills/:id`
   - Show: name, ID, scope, description, trigger, body (in a code block or rendered markdown), created/updated dates
   - "Edit" button → navigate to `/skills/:id/edit`
   - "Delete" button → `DELETE /skills/:id` with confirmation, redirect to list

5c. **Skill editor page** (`/skills/new` and `/skills/:id/edit`):
   - Form fields: name (text), id (text, auto-generated from name on create), description (textarea), trigger (textarea), scope (select: coordinator), body (large textarea)
   - On create: `POST /skills` with body, redirect to detail page
   - On edit: `PUT /skills/:id` with body, redirect to detail page
   - Validation: name required, id required, description required, body required

**API endpoints used:**
- `GET /skills/:id` — exists
- `POST /skills` — exists
- `PUT /skills/:id` — exists
- `DELETE /skills/:id` — exists

**Dependencies:** Step 1 (infrastructure)

---

### Step 6: Wiki — Detail/Create/Edit/Delete Pages

**Files to modify:**
- `drone-coordinator-ui/src/pages/wiki.tsx`
- `drone-coordinator-ui/src/App.tsx` (add routes)
- `drone-coordinator-ui/src/lib/types.ts` (add WikiPage full type if not already)

**New files:**
- `drone-coordinator-ui/src/pages/wiki-detail.tsx`
- `drone-coordinator-ui/src/pages/wiki-editor.tsx` (shared by create + edit)

**Details:**

6a. **Wiki list page enhancements**:
   - Add "New Page" button → navigate to `/wiki/new`
   - Make wiki cards clickable → navigate to `/wiki/:pageId`
   - Add "Delete" button on each card → `DELETE /wiki/:pageId` with confirmation
   - Add search input → `GET /wiki/search?q=` endpoint
   - Add pagination (client-side)

6b. **Wiki detail page** (`/wiki/:pageId`):
   - Fetch `GET /wiki/:pageId`
   - Show: title, ID, scope, tags, sources, content (rendered as markdown), created/updated dates
   - "Edit" button → navigate to `/wiki/:pageId/edit`
   - "Delete" button → `DELETE /wiki/:pageId` with confirmation, redirect to list

6c. **Wiki editor page** (`/wiki/new` and `/wiki/:pageId/edit`):
   - Form fields: pageId (text, auto-generated from title on create), title (text), content (large textarea for markdown), scope (select: coordinator), tags (comma-separated input), sources (comma-separated input)
   - On create: `PUT /wiki/:pageId` with body, redirect to detail page
   - On edit: `PUT /wiki/:pageId` with body, redirect to detail page
   - Validation: title required, content required

**API endpoints used:**
- `GET /wiki/:pageId` — exists
- `PUT /wiki/:pageId` — exists
- `DELETE /wiki/:pageId` — exists
- `GET /wiki/search?q=` — exists

**Dependencies:** Step 1 (infrastructure)

---

### Step 7: Navigation Updates

**Files to modify:**
- `drone-coordinator-ui/src/App.tsx`

**Details:**

7a. Add all new routes to the router:
```
/personas/:id          → PersonaDetailPage
/personas/:id/edit     → PersonaEditorPage (edit mode)
/personas/new          → PersonaEditorPage (create mode)
/skills/:id            → SkillDetailPage
/skills/:id/edit       → SkillEditorPage (edit mode)
/skills/new            → SkillEditorPage (create mode)
/wiki/:pageId          → WikiDetailPage
/wiki/:pageId/edit     → WikiEditorPage (edit mode)
/wiki/new              → WikiEditorPage (create mode)
/beacons/:id           → BeaconDetailPage
```

7b. Add dark mode toggle to sidebar footer (between version text and the toggle).

7c. Update nav items if needed (no new top-level nav items — all new pages are drill-downs from existing ones).

**Dependencies:** Steps 2-6 (all new pages must exist)

---

### Step 8: Validation & Polish

**Details:**

8a. Run `pnpm typecheck` in drone-coordinator-ui — fix any TypeScript errors.

8b. Run `pnpm build` in drone-coordinator-ui — ensure production build succeeds.

8c. Run `pnpm -r run lint` at workspace root — ensure no lint errors.

8d. Run `pnpm -r run test` at workspace root — ensure all tests pass (including new UI tests).

8e. Manual smoke test: start coordinator, open UI, verify all pages render, all CRUD operations work, dark mode toggle works, search works, pagination works.

**Dependencies:** Steps 1-7

---

## Validation Criteria

1. ✅ All LSP checks pass (no TypeScript errors in any workspace package)
2. ✅ `pnpm -r run lint` passes with zero errors
3. ✅ `pnpm -r run build` passes for all packages (including drone-coordinator-ui)
4. ✅ `pnpm -r run test` passes (including new UI tests)
5. ✅ All 6 existing pages have management actions (create/edit/delete where applicable)
6. ✅ Beacon detail page shows beacon info, sessions, and agents
7. ✅ Dark mode toggle works and persists
8. ✅ Search works on list pages (client-side for personas/skills, API-backed for wiki)
9. ✅ Pagination works on list pages
10. ✅ Error states are shown instead of silent failures
11. ✅ Loading states use skeleton components instead of "Loading..." text
12. ✅ Confirmation dialogs appear before destructive actions (delete, terminate, reject)

---

## Implementation Summary

**Completed:** 2026-07-21

All 8 steps implemented. 25 files changed (4,284 insertions, 234 deletions). All validation criteria pass.

### What was built:
- **New pages (10):** beacon-detail, persona-detail, persona-editor, skill-detail, skill-editor, wiki-detail, wiki-editor
- **New components (3):** Dialog, Input, Skeleton
- **New hooks (1):** useApi (reusable fetch with loading/error/data)
- **New infrastructure:** vitest config, test setup, use-auth tests
- **Updated pages (6):** topology, sessions, personas, skills, wiki, App
- **Updated types:** Added BeaconDetail, CreatePersonaRequest, CreateSkillRequest, CreateWikiPageRequest, PaginationState, PaginatedResponse

### Key design decisions:
- Dedicated detail/edit pages (not modals) for personas, skills, wiki — better for long content
- Client-side pagination for small lists (personas, skills, wiki, beacons); server-side for sessions
- Client-side search for personas/skills; API-backed search for wiki
- Dark mode toggle in sidebar footer with localStorage persistence
- Confirmation dialogs for all destructive actions (delete, terminate, reject, remove)