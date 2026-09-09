---
key: coordinator-ui-error-display-sweep-backlog
tags: []
created: 2026-09-09T15:17:38.941Z
updated: 2026-09-09T15:32:12.825Z
---

# Coordinator UI — error-display sweep backlog

Deferred from plan `plan-coordinator-ui-archive-undo-and-error-display` (user chose sessions-page-only scope; sessions page wiring COMPLETED 2026-09-09). `ToastProvider` (`src/hooks/use-toast.tsx`) + `ErrorBanner` (`src/components/error-banner.tsx`) now exist as the shared primitives — see the completed plan memory for their exact APIs. Remaining wiring, per the 2026-09-09 error-handling survey:

1. **Six delete handlers** — `if (res.ok)` with no else + empty catch: `wiki.tsx` handleDelete (~L121-139), `skills.tsx` (~L62-76), `personas.tsx` (~L59-75), `skill-detail.tsx` (~L41-53), `persona-detail.tsx` (~L45-53), `wiki-detail.tsx` (~L49-56). → toast.error on failure; rows stay stale today.
2. **topology.tsx handleDialogConfirm** (~L146-181) — approve/reject/remove beacon trust: all three branches silent on failure, dialog closes regardless, empty catch. → toast.error + decide whether dialog should stay open on failure. No tests cover these paths.
3. **session-detail.tsx** (~L32-37) — no res.ok check + `catch { // Handle error }` doing literally nothing; failed events load renders "No events yet" forever. → add error state or toast.
4. **wiki.tsx search effect** (~L99-112) — silent fallback to unfiltered list on failure. → decide toast vs leave.
5. **sessions.tsx beacon-name enrichment** (~L96) — silent degrade to raw beacon IDs; likely intentional, but note it during the sweep.
6. **login.tsx** — inline field error is fine as-is; no change.
7. **Dead code decision:** `src/hooks/use-api.ts` is an unused, well-built `useApi` hook with error normalization (`body.error || 'HTTP {status}: {statusText}'`). Either promote it as the shared res.ok-normalizing fetch layer for the sweep or delete it.
8. **Test debt:** no page test asserts ANY error UI today (the new sessions/toast/banner tests from the completed plan are the first); add error-path assertions using the `jsonResponse(status, body)` + `vi.stubGlobal('fetch', …)` idiom while sweeping.
9. **Banner swap (mechanical, 12 sites):** remaining pages still render the copy-pasted destructive banner inline (`topology.tsx` ~L262-266, `persona-editor.tsx` ~L163-167, `skill-editor.tsx` ~L166-170, `wiki-editor.tsx` ~L168-172, `wiki.tsx` ~L177-186 (two: error+graphError), `wiki-tag.tsx` ~L64-68). Swap for `<ErrorBanner message={error} />` exactly as done in sessions.tsx. The detail pages' full-page muted center text (beacon/persona/skill/wiki-detail) is a different pattern — decide whether those adopt ErrorBanner or stay.

## Separate list-integrity item (surfaced during archive-plan exploration, deliberately deferred)

- `sessions.tsx` WS `initial` handler (~L129-145 pre-rework; still present) blindly PREPENDS any snapshot sessions not already in the list; the coordinator's initial snapshot is active-sessions-only (`drone-coordinator/src/index.ts` ~L437). Result: active sessions injected at the TOP of the list on WS (re)connect — including in the archived view. Needs its own design decision: proper merge semantics, or drop the `initial` subscription in favor of `session.*` event subscriptions (established pattern: `topology.tsx` ~L60-64, `session-detail.tsx` ~L49, `beacon-detail.tsx` ~L77-94). Note: after the archive rework, the prepend also lands ABOVE any merged pending-rows (which sit sorted by createdAt) — same class of wrong-position symptom the archive fix addressed.
