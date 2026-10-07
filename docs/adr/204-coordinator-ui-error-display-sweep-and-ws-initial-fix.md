---
tags: [coordinator, coordinator-ui, error-handling, websocket, sessions, adr]
related: [drone-coordinator-ui.md, decisions/203-coordinator-ui-archive-undo-and-error-display.md, decisions/198-coordinator-ui-launch-interact.md, decisions/190-coordinator-session-archive.md, concepts/session-management.md]
---

# Coordinator UI error-display sweep + sessions WS initial-prepend fix

**Summary**: Executes the deferred error-display sweep from [[decisions/203-coordinator-ui-archive-undo-and-error-display]] — promotes the previously-unused `useApi` hook as the shared fetch layer (fixing two latent bugs that zero tests and zero consumers had hidden), wires toast errors into every remaining silent-failure handler (six delete handlers, the topology trust dialog, the session-detail events load, the wiki search effect), swaps all nine remaining copy-pasted destructive banners for the shared `ErrorBanner`, and adds a 350ms debounce to wiki search. Then resolves the backlog's separate list-integrity item: the sessions page stops consuming the WebSocket `initial` snapshot (which blindly prepended active-only sessions at the top of the list on every reconnect) in favor of a session-lifecycle event allowlist that triggers debounced server-truth refetches.

## Context

The completed sessions-page-only plan (ADR 203) left a backlog memory (`coordinator-ui-error-display-sweep-backlog`) of nine remaining wiring items plus one deliberate design item. Survey findings from the 2026-09-09 error-handling survey: six delete handlers with `if (res.ok)` and no else + empty catches, a topology trust dialog silent on all three failure branches, a session-detail events load whose catch block was literally `// Handle error`, a wiki search that silently fell back to the unfiltered list on failure, eleven-plus duplicated inline banners, an unused well-built `useApi` hook, and zero page tests asserting any error UI outside sessions.

## Decision

**Promote `useApi`, don't delete it — but test-first.** `src/hooks/use-api.ts` was an unused, well-built hook. Promotion followed TDD: the test suite was written before anything consumed the hook, and it failed 5/7 immediately — **the hook never fetched automatically at all**. Its `urlRef.current !== url` guard was false at mount because the ref was initialized *with* the current url, so the effect skipped its own mount fetch; only manual `refetch()` ever worked. The fix deletes the dead guard (the effect runs on mount and on url change, driven by `fetchData` identity). A second bug surfaced from page-level tests: a non-ok response with no statusText produced `HTTP 500: undefined` — the shared `extractApiError(res)` now falls back to `HTTP {status}: {statusText || 'Unknown error'}`. The hook exports two normalizers, and `useApi` itself consumes both: `extractApiError(res)` (body `error` field, else HTTP status text) and `networkErrorMessage(err)` (Error message or `Network error`).

**Toast on every action failure.** All six delete handlers (wiki, skills, personas, skill-detail, persona-detail, wiki-detail) follow the uniform shape: `if (!res.ok) { showError(await extractApiError(res)); return; }`, catch → `showError(networkErrorMessage(err))`; rows/navigate change only on success. The topology trust dialog's three near-identical branches collapsed into one (`remove` → `DELETE /api/beacons/trust/:id`, otherwise `POST .../${action}`); on failure it **keeps the dialog open** (user decision: failure feedback + retry-or-cancel in place beats closing-and-ambiguity), closing plus refetching `GET /api/beacons` only on success. The session-detail events load is a *load*, not an action: failure sets an error state rendered as `<ErrorBanner>` between the header and Session Info card — the "No events yet" empty state deliberately stays below it, so live WS events recover the page visually without a refetch — and the banner clears on the next fetch (stale-error reset per `sessionId`). The wiki search effect toasts on failure (user-initiated one-shot action) instead of silently degrading.

**Search debounce (approved scope addition).** Making search failures visible exposed a pre-existing wart: the search effect had no debounce, so every keystroke fired a request — a failing search toasted once per keystroke (stack-capped at 4). The effect now debounces `SEARCH_DEBOUNCE_MS` (350ms) with a trailing timer plus a stale-response guard (a superseded in-flight request cannot overwrite a newer one's results).

**Banner swap — nine sites, not seven.** All inline destructive banners → `<ErrorBanner message={error} />`: topology, persona-editor, skill-editor, wiki-editor, wiki (two: `error` + `graphError`), wiki-tag, plus two the backlog list missed (personas, skills) found by grepping for the legacy classes. Zero copy-pasted banners remain in `pages/`. The detail pages' full-page muted "not found" center text intentionally stays — a whole-page missing resource is a different presentation from a banner above working content, and "not found" is not an error. login.tsx's inline red field-level error also stays (form-field errors belong at the field; its permissive 429/5xx/network fallbacks are deliberate).

**Accepted degrades, no change:** sessions.tsx beacon-name enrichment silently degrades to raw beacon IDs when `GET /api/beacons` fails (intentional); the generic relay events on the WS `event` channel are ignored by the sessions page (below).

**Sessions WS `initial` blind-prepend → lifecycle-event refetches (Semantics B).** The coordinator's `initial` snapshot (`publishInitialState`, active-sessions-only via `listSwarmSessions({ status: 'active' })`) was blindly prepended by sessions.tsx on every WS (re)connect: active sessions injected at the TOP of a `createdAt DESC` list — including inside the archived view and above the merged pending-undo rows. Three candidate designs: (1) event-driven replacement, (2) server-side view-aware snapshot protocol, (3) client-side merge-and-resort. Chosen: **drop the `initial` subscription** (option 1) with **semantics B** — subscribe to the session-lifecycle allowlist (`session.created|ended|processing|processed|archived`, all published via `publishMutationEvent` with `{ sessionId, status }` payloads) and have each event trigger `fetchSessions(offsetRef.current)`, debounced at 100ms so an event burst (register→end, processing→processed) causes one refetch. Refetches reuse the ADR 203 machinery wholesale: the pending-undo merge, `total`/`hasMore` re-sync, and the current view filter (`exclude=archived` / `status=archived`) are respected by construction because the server is the only source of rows. Semantics A (per-event row surgery, no refetch) was rejected: more moving parts, five event types needing distinct row surgery, while the refetch path was already proven and pending-safe. A generic "any event" trigger was rejected because the coordinator relays every agent-turn event (`message`, `roundComplete`, …) through the same channel — that would refetch the sessions list per agent action. No server change: `initial` still serves topology (beacons/agentLocations) and session-detail bootstrap, where a whole-store snapshot is the right tool.

## Tests

- `use-api.test.tsx` (new, 10) — mount fetch + data, null-url no-fetch, body-error message, statusText fallback, `Unknown error` fallback (regression for the `undefined` bug), network error message, `immediate: false` + refetch, url-change refetch, and the two `extractApiError` cases. The url-change test failed pre-fix (5/7 red) proving the never-fetch bug.
- `skills.test.tsx` / `personas.test.tsx` (new, 3 each) — failed delete (409 body message), generic fallback (`HTTP 500: Unknown error`), success removes the row; dialog confirm scoped via `within(screen.findByRole('dialog'))`.
- `skill-detail.test.tsx` / `persona-detail.test.tsx` (new, 3 each) — failure stays on page, fallback toast, success navigates to the list.
- `wiki-detail.test.tsx` (+3) and `wiki.test.tsx` (+1, search-failure toast asserting exactly 1 request and 1 toast post-debounce).
- `topology.test.tsx` (+4) — approve 409 / remove 500 → toast + dialog stays open; reject/remove success → dialog closed, beacon list refetched (2 `GET /api/beacons` calls), badge updated.
- `session-detail.test.tsx` (new, 4 — the page's first tests; jsdom lacks `scrollIntoView`, stubbed on `Element.prototype` in `beforeAll`, which is likely why the page was never tested) — success renders event cards; 500 → banner + empty state intact; navigating to a healthy session clears the banner (real router navigation, not `rerender`); 500 without body → `Unknown error`.
- `sessions.test.tsx` (+5) — lifecycle event → refetch at current offset; 3-event burst → exactly one refetch (fake timers); relay events (`message`/`roundComplete`) → no refetch; **`initial` snapshot arriving → no state change** (pins the original prepend bug); archived view → refetch keeps `status=archived`. Test-infra note: earlier describe blocks `vi.unstubAllGlobals()` in `afterEach`, which removed the module-level WebSocket stub — the new block re-stubs per-test.

Validation: UI suite 166 → 205 passed; UI typecheck + root lint (prettier included) clean throughout.

## Alternatives considered

- **Delete `useApi`** and hand-roll per-handler error strings — rejected: six-plus copies of the same `body.error || statusText` dance; promotion + shared `extractApiError`/`networkErrorMessage` centralizes it.
- **Banner instead of toast for search failures** — rejected: a search is a one-shot user action, not persistent page state; and the empty state still describes the unfiltered list.
- **Server-side fix for `initial`** (client sends its view, server replies with a matching snapshot) — rejected: a new client→server message type plus per-view snapshot routes for one consumer, when the existing event allowlist covers the need.
- **Client-side merge-and-resort of the `initial` snapshot (smallest patch)** — rejected: fixes position but not pagination-boundary mixing or the no-removals gap; still snapshot-injection rather than event-driven truth.
- **Per-event row surgery without refetch (semantics A)** — rejected for B's simplicity: always server-truth, reuses pending-merge; trade-off is a refetch per burst instead of in-place badge flips.

## Consequences

- Every destructive action and load in the coordinator UI now surfaces failure (toast or banner, per the ADR 203 division of labor); no silent catch blocks remain in pages.
- `useApi` is real but still has no consumers beyond its tests — promotion created the shared layer; future GET-based pages should adopt it (its mount/url-change/refetch semantics are now proven).
- Sessions list liveness is event-driven with server-truth rows; a reconnect no longer reshuffles the list. Gap accepted: status badges update on the next refetch rather than in-place on each event.
- The backlog memory is a completion record; this ADR supersedes its contents.

## Related

- [[decisions/203-coordinator-ui-archive-undo-and-error-display]] — the toast/banner primitives and sessions-page hardening this sweep extends
- [[decisions/190-coordinator-session-archive]] — archive/restore backend + the `exclude=`/`status=` filters the refetch path respects
- [[decisions/191-topology-live-ws-status]] — topology's `initial` + `event` subscription pattern the sessions page now partially follows
- [[decisions/198-coordinator-ui-launch-interact]] — the WS reverse-channel context for coordinator pushes
- [[modules/drone-coordinator-ui]] — module overview