---
tags: [beacon, coordinator, proxy, wiki, error-handling, adr]
related:
  [
    decisions/206-wiki-delete-coordinator-scope.md,
    modules/drone-beacon.md,
    concepts/semantic-search.md,
  ]
---

# Beacon proxy forwards the coordinator's real status + body; 502 reserved for no-response

**Summary**: The beacon's shared coordinator proxy collapsed every non-2xx response to `null`, so beacon routes could only report a generic `502 Failed to proxy to coordinator` — the coordinator's actual status and error body were discarded one hop away from the caller. This made a coordinator-side validation failure (`400 Pitch is too long…`) indistinguishable from a coordinator outage, and the LLM could not see why its `swarm__wiki_write` failed. A new `proxyToCoordinatorDetailed` in `drone-beacon/src/routes/context.ts` returns `{ responded, status, body }` and is consumed by the wiki write/delete proxy branches; `502` now means strictly "no coordinator response existed" (no client configured, or transport failure). This supersedes the "502 = coordinator responded non-2xx" rule recorded in the swarm wiki's coordinator-proxy principle.

## Context

`swarm__wiki_write` with `scope: "coordinator"` returned `{"success":false,"error":"Failed to proxy to coordinator"}`. Reproduced end to end:

| Layer                                                                        | Behavior                                                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `writePage()` → `validatePitch()` (`drone-swarm-common/src/wiki-storage.ts`) | Throws `Pitch is too long. Keep it under 400 characters…` (observed payload pitch = 625, cap = 400) |
| Coordinator `PUT /api/wiki/:id`                                              | Returns **400** + `{"error":"Pitch is too long…"}` — already correct                                |
| Beacon `proxyCall` (`drone-beacon/src/routes/context.ts`)                    | `if (!res.ok) return null` — **collapsed the 400 and its body to `null`**                           |
| Beacon wiki `PUT` coordinator branch                                         | `if (!result)` → **502 `Failed to proxy to coordinator`** — the mask                                |
| Agent `wiki_write` (`drone-agent/src/plugins/swarm/tools-wiki.ts`)           | Already surfaces `err.error` — would have worked had the real body arrived                          |

The beacon-scope branch already surfaced the real message (`catch → 400 { error: err.message }`); **only the proxy path masked it**. The reject-on-write pitch validation is intentional (keep new entries compliant, truncate only on the read side for pre-existing entries), so the defect is purely one of error propagation.

ADR [206-wiki-delete-coordinator-scope](206-wiki-delete-coordinator-scope.md) had recorded "the proxy still collapses coordinator 5xx to `null`" as an _accepted limitation_ for the delete path. Because `proxyCall` is shared by wiki, insights, and principles, the limitation was never scoped to that one route — it reappeared as a fresh, hard-to-diagnose bug on the wiki write path. This ADR reverses that acceptance for the wiki paths.

## Decision

1. **Extract a low-level `fetchCoordinator(method, path, body)`** in `drone-beacon/src/routes/context.ts` so the ADR-206 header discipline (Content-Type sent only together with a body, avoiding `FST_ERR_CTP_EMPTY_JSON_BODY`) is preserved for every caller. The legacy `proxyCall` is refactored to delegate to it and keeps its behavior **byte-identical** — `null` on no-client and on non-2xx, throwing on transport failure and on a non-JSON 2xx body. `proxyToCoordinator` (insights/principles) and `proxyWikiToCoordinator` (the remaining wiki GET call sites) are unchanged.
2. **Add `proxyToCoordinatorDetailed` returning `{ responded, status, body }`.** It never throws: `responded: false` means no coordinator response existed at all (no client configured, or transport failure). A 2xx body is parsed with `res.json()`; a non-2xx body goes through `readErrorBody`, which passes a JSON object through untouched (the coordinator's own `{ error }` shape) and otherwise emits `{ error: <trimmed text> }`, capped at `ERROR_BODY_MAX_CHARS = 500` so a large HTML error page cannot bloat the tool result.
3. **The wiki `PUT` coordinator branch forwards the coordinator's status + body verbatim**; `502 Failed to proxy to coordinator` is emitted only when `!responded`.
4. **Both wiki `DELETE` branches use the detailed proxy too.** `scope=coordinator`: no-response → 502; `404` → the beacon's `404 Wiki page not found`; any other `>= 400` → forward that status + body; 2xx → reindex + return the body. No-scope: the ADR-206 partial-delete semantics are preserved — the coordinator's real error is forwarded **only when nothing was deleted**; if the beacon-local half was deleted, the call still returns `{ success: true, beaconDeleted: true, coordinatorDeleted: false }`.
5. **`502` is reserved for "no coordinator response".** A coordinator that answered — at any status — has its status and body relayed to the caller.
6. **The project-wide rollout is deferred.** Only the wiki write/delete branches consume the detailed helper in this change; insights, principles, and the wiki GET proxies keep the collapsing `proxyCall` until a follow-up.

## Rationale

- **A knowingly-accepted limitation on a shared helper is not scoped to the route that accepted it.** ADR-206's trade-off lived in `proxyCall`, which serves three route families; the cost surfaced later on a different route.
- **Verbatuim forwarding is standard reverse-proxy behavior and costs nothing extra** — the status is already in hand — whereas any re-wrapping hides the coordinator's `{ error }` message behind a `details` field the agent does not read.
- **The coordinator's error body already uses the `error` key that `wiki_write` reads**, so verbatim forwarding required zero agent-side changes.
- **Preserving the collapse in `proxyCall` keeps the change minimal**: insights/principles and every wiki GET retain their existing observable behavior, and only the two paths with the reported defect change.

## Implementation

- `drone-beacon/src/routes/context.ts` — `fetchCoordinator`, `proxyCall` (delegating, unchanged semantics), `ERROR_BODY_MAX_CHARS`, `readErrorBody`, `CoordinatorProxyResult`, `proxyToCoordinatorDetailed`
- `drone-beacon/src/routes/wiki.ts` — the `PUT` coordinator branch and both `DELETE` branches rewired to `proxyToCoordinatorDetailed`; GET call sites untouched

## Tests

- `drone-beacon/test/coordinator-proxy.test.ts` — coordinator 400 on a coordinator-scope PUT forwards status + exact error body; unreachable coordinator → generic 502; coordinator 500 on a `scope=coordinator` DELETE forwards 500 + body instead of a 404; coordinator 404 delete still maps to the beacon 404 message; a regression guard that `proxyToCoordinator` still collapses a non-2xx to `null`
- `drone-beacon/test/wiki-origin-reads.test.ts` — non-JSON error body → `{ error: <text> }`; no-scope DELETE with a coordinator 500 **and** a local page keeps `{ success: true, beaconDeleted: true, coordinatorDeleted: false }`; no-scope DELETE with a coordinator 500 and **no** local page forwards 500 + body; no-scope DELETE with an unreachable coordinator and no local page → generic 502

## Key Points

- **`502 Failed to proxy to coordinator` now means exactly one thing**: no coordinator response existed. Any other failure relays the coordinator's own status and body.
- **`proxyCall` is behaviorally unchanged**, so insights, principles, and the wiki GET proxies are untouched by this change.
- **Pitch validation is unchanged** — reject-on-write at 400 chars, truncate-on-read for pre-existing longer pitches; only the error's visibility changed.
- **The deferred rollout**: insights/principles/other proxies still collapse errors to `null`.

## Related

- [206-wiki-delete-coordinator-scope](206-wiki-delete-coordinator-scope.md) — the delete-path fix whose proxy-collapse limitation this supersedes
- [drone-beacon](../../drone-beacon/) — the proxy helper and the wiki routes
