---
tags: [beacon, coordinator, swarm, wiki, proxy, fastify, adr]
related:
  [
    drone-beacon.md,
    drone-swarm-common.md,
    drone-agent-plugins.md,
    decisions/179-swarm-memory-rag-retrieval.md,
    decisions/177-reverse-channel-session-end-trigger.md,
    decisions/190-coordinator-session-archive.md,
  ]
---

# Coordinator-scope deletes: proxy content-type fix + both-sides no-scope wiki delete

**Summary**: Fixes the swarm wiki delete bug where `swarm__wiki_delete` failed on coordinator-scoped pages. Root cause (proven by a wire-level repro): the beacon's two coordinator proxy helpers always sent `Content-Type: application/json`, even on bodyless DELETEs; Fastify 5 on the coordinator rejects that with `FST_ERR_CTP_EMPTY_JSON_BODY`, the proxy collapsed the 400 to `null`, and the beacon answered a misleading `404 "Wiki page not found"`. The proxy now sends the header only together with a body (the outbox-flusher precedent), both helpers share one implementation, and the cached coordinator fetch resets when the client is set. In the same change, a no-scope wiki delete now removes both origins (mirroring the no-scope read), `deletePage` returns an honest boolean instead of always `true`, the agent tool surfaces the beacon's error body, and coordinator-scope deletes trigger a wiki reindex.

## Context

`swarm__wiki_delete {pageId, scope: 'coordinator'}` failed with the generic "Failed to delete wiki page", while beacon-scope deletes worked. The investigation (planning session agent-1789051190802) traced agent tool → beacon `DELETE /wiki/:pageId` → `proxyWikiToCoordinator` → coordinator `DELETE /wiki/:pageId` and converged on the proxy header as the suspect; this ADR's fix confirmed it with a live repro.

1. **Proxy header.** `drone-beacon/src/routes/context.ts` had two byte-identical helpers (`proxyToCoordinator`, `proxyWikiToCoordinator`) that set `headers: { 'Content-Type': 'application/json' }` unconditionally, with `body: body ? JSON.stringify(body) : undefined`. On bodyless DELETEs undici still puts the header on the wire, Fastify 5.12.1 sees `application/json` and rejects the empty body (`400 FST_ERR_CTP_EMPTY_JSON_BODY`) before any route handler runs. The proxy collapses every non-OK response to `null`, so the beacon returned `404 "Wiki page not found"` — the handler never executed, the page was never deleted. GETs never reach the JSON parser (no body expected), which is why every proxied read/write worked and only DELETE was broken. The repo's own `drone-beacon/src/outbox-flusher.ts:65-66` documents exactly this Fastify behavior and the header-only-with-body workaround (the beacon's outbox already used it; the route proxies did not).
2. **Blast radius.** All three proxied DELETEs shared the defect: wiki (`routes/wiki.ts`), insights (`routes/insights.ts`), principles (`routes/principles.ts`) — all `scope=coordinator` deletes. Fragments were NOT affected (the beacon's fragment DELETE is local-only; the coordinator's fragment route is read-only v1).
3. **No-scope delete gap.** The wiki DELETE handler with no `?scope=` deleted only the beacon-local copy and returned success — a coordinator-only page 404'd without the coordinator side ever being tried, and a dual-scope page was silently half-deleted. This mirrored nothing: the no-scope read returns ALL versions tagged by origin.
4. **Dishonest `deletePage`.** `drone-swarm-common` `deletePage` used `rm(path, { force: true })` and returned `true` unconditionally, so the route could not tell "deleted" from "did not exist". This masked 404s on the old no-scope path and made any accurate per-side result impossible.
5. **Silent agent tool.** `wiki_delete` discarded the beacon's error JSON and showed a hardcoded "Failed to delete wiki page", hiding the actual failure from the LLM.

## Decision

1. **Header only with a body.** The proxy sets `Content-Type: application/json` if and only if `body != null`, and sends the serialized body only then. Bodyless DELETEs go out headerless and bodyless, which the coordinator accepts. This is decision (A) from the planning session; sending `{}` on bodyless DELETEs was rejected as semantically wrong and inconsistent with the outbox-flusher precedent.
2. **One shared implementation.** The two byte-identical exported helpers collapse into one private `proxyCall(method, path, body?)`; `proxyToCoordinator` and `proxyWikiToCoordinator` are exported bindings of it. The ~20 call sites keep their names and signatures.
3. **Cached coordinator fetch resets on `setCoordinatorClient`.** The lazy `_coordinatorFetch` capture was never invalidated, so a new coordinator connection (new pinned fingerprint / new mTLS identity) would keep proxying with the previous identity's fetch. `setCoordinatorClient` now clears the cache; the next proxied call re-captures from the current client. Found via test interference (a stale cached fetch from a prior test bled into later cases); the underlying staleness is a real production defect.
4. **No-scope delete spans both origins.** `DELETE /wiki/:pageId` without `scope` deletes the beacon-local copy AND proxies a DELETE to the coordinator; a coordinator 404 counts as nothing-to-do on that side. Success iff at least one side was deleted; otherwise 404. The success payload is `{ success: true, beaconDeleted, coordinatorDeleted }`. An explicit `scope=beacon` branch keeps local-only filter semantics (previously it fell through with no-scope; now the distinction is explicit). `scope=coordinator` behavior is unchanged apart from gaining the reindex trigger (it never fired one before).
5. **Honest `deletePage`.** Drops `force: true` so `rm` fails on a missing file and the function returns `false`; the catch still maps other I/O errors to `false`.
6. **Agent tool transparency.** `wiki_delete` parses the beacon's error body (`err.error || 'Failed to delete wiki page'`, same shape as `wiki_write`) and its description states that no-scope deletes all versions (beacon + coordinator) while `scope` narrows the delete.
7. **Accepted limitation (documented, not fixed).** The proxy still collapses coordinator 5xx to `null`, indistinguishable from a 404, so a no-scope delete during coordinator downtime can delete only the local half. The wiki reindex reconcile (ADR 179's deletion-tight set-difference) cleans up the drift on the next cycle. Changing the collapse-on-error contract is out of scope.

## Implementation

- `drone-beacon/src/routes/context.ts` — shared private `proxyCall` with conditional header/body; both exported helpers bind to it; jsdoc cites `FST_ERR_CTP_EMPTY_JSON_BODY` and the outbox-flusher precedent; `setCoordinatorClient` resets `_coordinatorFetch`.
- `drone-beacon/src/routes/wiki.ts` — DELETE handler: `scope=coordinator` unchanged plus `triggerWikiReindex()`; new explicit `scope=beacon` filter branch; no-scope deletes both sides and returns the detailed payload; 404 only when neither side deleted; reindex on every success path.
- `drone-swarm-common/src/wiki-storage.ts` — `deletePage` drops `rm`'s `force: true`; jsdoc states the honest-boolean contract.
- `drone-agent/src/plugins/swarm/tools-wiki.ts` — `wiki_delete` surfaces the beacon error body; description documents no-scope semantics.
- No coordinator changes (its DELETE route already returned proper 404s); no drone-core type changes.

## Tests

- `drone-beacon/test/coordinator-proxy.test.ts` — "proxyCall header discipline" describe: bodyless DELETE sends no `content-type` header and no body; PUT sends the header together with the serialized body; bodyless GET sends no header. Uses a fake coordinator client (`setCoordinatorClient` + capturing `getFetch` spy); the mock fetch returns a FRESH `Response` per call (a `Response` body is consumed once — a shared instance breaks `res.json()` in later calls).
- `drone-beacon/test/wiki-origin-reads.test.ts` — "wiki delete scope semantics" describe (7 cases): coordinator-scope delete succeeds + reindex; coordinator-scope 404 without reindex; `scope=beacon` deletes local only and never calls the proxy; no-scope dual page → both deleted + proxy called; no-scope beacon-only page → coordinator still attempted, `coordinatorDeleted: false`; no-scope coordinator-only page → succeeds; no-scope missing page → 404 without reindex. `triggerWikiReindex` is mocked via `importOriginal` on `wiki-index-support.js` and asserted.
- `drone-swarm-common/test/wiki-storage.test.ts` — the `force`-delete pin flips: `deletePage('nonexistent')` now returns `false`.
- **Fail-first verification:** the three source files were stashed and the new tests run against the old code — 9 failures (all delete-semantics cases + the header cases + the honest-`deletePage` storage pin), then restored to green. The old code's no-scope path even returned `200 {success: true}` for pages that never existed locally, which the honest `deletePage` fixed and the tests pin.

## Key Points

- **Method-blind header sets break exactly the bodyless methods.** GET never reaches Fastify's JSON parser, PUT always has a body — so a conditional-header bug is invisible until the first bodyless DELETE. When a shared proxy handles every method, test each method's header/body shape, not just the happy path.
- **Duplicated helpers drift; one shared seam cannot.** The two byte-identical proxy twins got the fix for free once they were one function; keeping both exported names preserved every call site.
- **A cached resource captured from a settable dependency must reset when the dependency is set.** `_coordinatorFetch` froze the first coordinator identity for the process lifetime; `setCoordinatorClient` is the invalidation point.
- **Honest booleans are prerequisites for accurate multi-source operations.** No-scope delete's `{beaconDeleted, coordinatorDeleted}` result only means something because `deletePage` stopped returning unconditional `true`.
- **Fail-first on a stash keeps the proof cheap** — stash the sources, run the new tests, restore: 9 red before, all green after.

## Related

- [179-swarm-memory-rag-retrieval](179-swarm-memory-rag-retrieval.md) — the origin-tagged merged wiki reads whose no-scope semantics the delete now mirrors; the deletion-tight reindex reconcile that absorbs the accepted 5xx-collapse limitation
- [177-reverse-channel-session-end-trigger](177-reverse-channel-session-end-trigger.md) — where the outbox flusher first hit and documented `FST_ERR_CTP_EMPTY_JSON_BODY`
- [190-coordinator-session-archive](190-coordinator-session-archive.md) — beacon proxy forwarding conventions this delete proxy follows
- [173-swarm-prompt-fragments](173-swarm-prompt-fragments.md) — the fragments route explicitly NOT affected (local-only DELETE)
