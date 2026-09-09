---
key: plan-coordinator-ui-archive-undo-and-error-display
tags:
  []
created: 2026-09-09T15:17:38.940Z
updated: 2026-09-09T15:17:38.940Z
---

# Plan: Coordinator UI — archive undo-row fix + unified error display

**Branch base:** `feat/general-coordinator-ui-polish` (clean tree at planning time)
**Root causes (all in `drone-coordinator-ui/src/pages/sessions.tsx`):** single-slot `phantomArchive` state (L47, type L31-34) rendered as hard-coded FIRST table row (L372-409); `handleArchive` (L219-231) overwrites it on a second archive; expiry timer (L227-229) only clears state — no refetch, so `total`/`hasMore` go stale and the slot stays empty. `handleArchive` also never checks `res.ok` (backend 404/409). Server sorts `createdAt DESC` (`drone-coordinator/src/db/swarm-sessions.ts` listSwarmSessions), so refetch pulls the next page row up honestly.

## Locked decisions (user-confirmed)
1. **Option B — in-place pending rows.** Do NOT remove the row on archive. Flag it client-side (Archived badge + Undo button, no normal actions), keep it at its list position. Independent per-row timers in a ref → multiple simultaneous phantoms coexist; nothing is "replaced".
2. **res.ok hardening** on every sessions-page action POST; failure → toast, no fake state changes.
3. **Deferred:** WS `initial` snapshot prepend quirk (see follow-up memory).
4. **Hand-rolled toast** (no sonner/react-hot-toast): `ToastProvider` + `useToast()` in `src/hooks/use-toast.tsx`, viewport mounted in `App.tsx`; plus shared `ErrorBanner` component replacing the copy-pasted destructive banner. Banners for load errors (persistent), toasts for action errors (transient).
5. **Scope:** wire ONLY the sessions page this pass; remaining silent-failure sites → follow-up memory note.

## Steps

| # | Task | Files | Agent | Depends |
|---|------|-------|-------|---------|
| 1 | Toast infrastructure + app mount | NEW `src/hooks/use-toast.tsx`, NEW `src/hooks/use-toast.test.tsx`, MOD `src/App.tsx` | coder | — |
| 2 | ErrorBanner component | NEW `src/components/error-banner.tsx`, NEW `src/components/error-banner.test.tsx` | coder | — |
| 3 | Sessions page rework | MOD `src/pages/sessions.tsx` | coder | 1, 2 |
| 4 | Sessions page tests | MOD `src/pages/sessions.test.tsx` | coder | 3 |
| 5 | Review pass | (touched files) | reviewer | 4 |
| 6 | Full validation | — | coder | 5 |

### Step 1 — ToastProvider + useToast (coder)
`src/hooks/use-toast.tsx` (provider in the codebase's hooks/ provider convention, like use-auth.tsx/use-websocket.tsx):
- `ToastItem = { id: number; message: string }`; module consts `TOAST_DURATION_MS = 5000`, `MAX_TOASTS = 4`.
- Context value: `{ error: (message: string) => void }` (error-only for now; kind field unnecessary until a second kind exists).
- `error()` appends `{ id: nextId.current++, message }`, caps stack by slicing to last `MAX_TOASTS - 1` before append, schedules `setTimeout(() => dismiss(id), TOAST_DURATION_MS)`.
- Provider renders children + fixed viewport: `fixed bottom-4 right-4 z-50 flex flex-col gap-2`, container `aria-live="assertive"`; each toast `role="alert"`, destructive palette (`border-destructive/40 bg-destructive/10 text-destructive`), manual dismiss button.
- Export `useToast()` that throws outside provider.
- `src/App.tsx`: wrap the existing provider stack with `<ToastProvider>` (outermost — no dependencies on auth/WS/router).
- Test `src/hooks/use-toast.test.tsx`: renders on error(), auto-dismiss after duration (fake timers), stacks multiple, cap enforced, manual dismiss.

### Step 2 — ErrorBanner (coder)
`src/components/error-banner.tsx`:
```tsx
export function ErrorBanner({ message, className }: { message: string; className?: string }) {
  if (!message) return null;
  return (
    <div role="alert" className={cn('mb-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm', className)}>
      {message}
    </div>
  );
}
```
(`cn` from `@/lib/utils`.) Test: renders message, `role="alert"`, returns null on empty.

### Step 3 — sessions.tsx rework (coder)
1. Delete `PhantomArchive` type, `phantomArchive` state, `cancelPhantomTimer`; delete the phantom header row block (L372-409).
2. Add: `const [archivedPendingIds, setArchivedPendingIds] = useState<Set<string>>(new Set());` + `const pendingRef = useRef<Map<string, { row: SessionRow; timer: ReturnType<typeof setTimeout> }>>(new Map());` + `const offsetRef = useRef(offset)` kept in sync by `useEffect(() => { offsetRef.current = offset; }, [offset]);` + unmount cleanup effect clearing all timers in `pendingRef`.
3. `const { error: showError } = useToast();` (alias — page already has `error` state).
4. `handleArchive(session)`: `const res = await authFetch(POST /api/sessions/:id/archive)`; `if (!res.ok) { showError('Failed to archive session'); return; }` — on success store row+timer in `pendingRef`, add id to `archivedPendingIds`. Timer callback (`expirePending(id)`): cancel timer, delete ref entry, remove id from set, then `fetchSessions(offsetRef.current)` (explicit current offset — never a stale captured one).
5. `handleUndoArchive(id)`: look up pending; if absent return; `clearTimeout`; POST restore; on response: clear pending (timer already cancelled), `if (!res.ok) showError('Failed to restore session')`, then `fetchSessions(offsetRef.current)` either way (server truth resolves the slot).
6. fetchSessions: after building `rows`, merge any `pendingRef` rows missing from the response (they are archived server-side, so `exclude=archived` dropped them): `merged.sort((a,b) => b.createdAt - a.createdAt).slice(0, PAGE_SIZE)` to match server DESC order; keep `total`/`hasMore` from the response as-is.
7. Row rendering: Status cell → `getStatusBadge(archivedPendingIds.has(session.id) ? 'archived' : session.status)`; Actions cell → if pending: ONLY an Undo button (`onClick={() => handleUndoArchive(session.id)}`); else the existing conditional action buttons unchanged.
8. Empty-state condition (L337): `sessions.length === 0` (drop `&& !phantomArchive` — pending rows now live in the list).
9. Replace the banner JSX (~L325-329) with `<ErrorBanner message={error} />`.
10. Add `res.ok` check + `showError('Failed to …')` + early return (no refresh) to: handleTerminate's `/end` POST (keep the permissive beacon DELETE try/catch), handleProcess, handleMarkProcessed, handleEnd, handleRestore.
11. Leave untouched: WS `initial` subscription (deferred), beacon-name enrichment silent degrade (L96).

### Step 4 — sessions tests (coder)
Add `<ToastProvider>` to the file's `wrapper`. Extend the `makeFetch` helper to support call-indexed/scripted responses (current one returns one payload for every GET).
- UPDATE 'shows a phantom row…' → row stays in place: Archived badge + Undo render, no Archive/End buttons on that row, sibling order preserved.
- UPDATE 'undo restores…' → plus assert a fresh sessions GET fires after undo.
- UPDATE 'phantom row disappears after the archive undo window' → expiry triggers refetch; second GET returns the NEXT row; assert it renders (symptom-3 acceptance).
- NEW 'a second archive leaves earlier undo rows intact' (two pendings, both Undo buttons, independent timers).
- NEW 'pending rows keep their list position' (3-row payload, archive middle row).
- NEW 'failed archive shows an error toast and keeps the row' (POST 500).
- NEW 'failed undo shows an error toast and refetches' (restore 409; assert toast + refetch).

### Step 5 — review (reviewer)
Focus: stale-closure safety (timer callbacks must use `offsetRef`, not captured offset/refresh); timer leaks on unmount/undo/expiry paths; no duplicate `clearPending` logic (single helper); AGENTS.md comment rules; dead code removed (old phantom remnants).

### Step 6 — validation (coder)
Run validation criteria below; fix any failures; re-run until green.

## Validation criteria
1. LSP: `lsp__get_diagnostics` clean for all of `drone-coordinator-ui/**`. (Pre-existing `drone-coordinator/test/beacon-ws.test.ts:167` diagnostic is a different package, tracked in project memory `pre-existing-integration-failures` — out of scope.)
2. `pnpm -r run lint` clean (eslint + prettier; do NOT hand-format — let prettier, and re-read files after it runs).
3. `pnpm -r run build` and `pnpm -r run typecheck` clean.
4. `pnpm -r run test` (fast suite) green. Targeted: `pnpm --filter drone-coordinator-ui test` — MUST run via the package script (NODE_ENV=test); bare vitest breaks React.act (ADR 190 note).
5. Acceptance mapping: symptom 1 → position-preservation test; symptom 2 → multi-phantom test; symptom 3 → expiry-refetch-loads-next-row test; error display → toast tests + banner test + failed-archive/failed-undo tests.

## Accepted transients (not bugs)
- Between archive and expiry, the "Showing X–Y of N" count is stale until the expiry/undo refetch.
- A pending row followed across pagination pages via the refetch-merge is accepted (single uniform code path; row is in limbo until undo/expiry).