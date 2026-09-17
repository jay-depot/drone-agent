---
key: fix-swarm-wiki-write-error-masking
tags:
  - plan
  - bugfix
  - swarm
  - wiki
  - beacon
  - proxy
  - error-handling
created: 2026-09-17T21:36:06.513Z
updated: 2026-09-17T21:36:06.513Z
---

# PLAN — Beacon proxy error forwarding: surface the coordinator's real error (fixes swarm__wiki_write masking)

Status: READY FOR EXECUTION. Branch: `feat/coordinator-config-ui-and-secure-storage` (in place — this bug blocks other testing on this branch).

## Summary & why

`swarm__wiki_write` with `scope: "coordinator"` returns the useless `{"success":false,"error":"Failed to proxy to coordinator"}`.
Reproduced end-to-end:

| Layer                                                                        | Behavior                                                                                            |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `writePage()` → `validatePitch()` (`drone-swarm-common/src/wiki-storage.ts`) | Throws `Pitch is too long. Keep it under 400 characters…` (observed payload pitch = 625, cap = 400) |
| Coordinator `PUT /api/wiki/:id`                                              | Returns **400** + `{"error":"Pitch is too long…"}` — already correct                                |
| Beacon `proxyCall` (`drone-beacon/src/routes/context.ts`)                    | `if (!res.ok) return null` — **collapses the 400 and its body to `null`**                           |
| Beacon wiki `PUT` coordinator branch                                         | `if (!result)` → **502 `Failed to proxy to coordinator`** — the mask                                |
| Agent `wiki_write` (`drone-agent/src/plugins/swarm/tools-wiki.ts`)           | Already surfaces `err.error` — would work if the real body arrived                                  |

The beacon-scope branch already surfaces the real message (`catch → 400 {error: err.message}`); **only the proxy path masks it.** The LLM therefore cannot see _why_ the write failed and retries blindly.

**Fix:** make the beacon forward the coordinator's real status + body on the wiki write/delete proxy paths, reserving `502 Failed to proxy to coordinator` for the case where no coordinator response exists at all.

## Locked design decisions (grilling Q1–Q10)

- **Q1** Keep reject-on-write. No change to validation behavior. Fix error propagation only.
- **Q2/Q3** The pitch cap is **400 on both sides already** (read side imports the same `MAX_PITCH_CHARS`). The "200" was a red herring; there is nothing to unify. **No numeric change** — keep both the ingest limit and the output trim exactly as-is.
- **Q4** Add ONE reusable detailed proxy helper in `context.ts`; refactor the existing `proxyCall` to delegate to a shared low-level fetch so its behavior stays **byte-identical** (insights/principles: zero blast radius). Only the wiki write/delete branches consume the detailed result.
- **Q5** When the coordinator responded, **forward its status + body verbatim**. `502 Failed to proxy to coordinator` is reserved for _no coordinator response_ (not configured, or transport failure).
- **Q6** The documented 502-on-non-2xx convention (`drone-agent-swarm-coordinator-proxy-principle`) is **superseded by experience**; the swarm wiki page will be reconciled by the ingest agent.
- **Q7** Include the two DELETE branches (same defect, same file).
- **Q8** No-scope DELETE: preserve ADR-206 partial-delete semantics; forward the coordinator's real error **only when nothing was deleted**.
- **Q9** Non-JSON error bodies → `{ error: <raw text, truncated> }` fallback. The 2xx path stays `res.json()` (byte-identical).
- **Q10** Add a short ADR (`decisions/210-*`).

## Explicit non-goals

- ❌ No change to `MAX_PITCH_CHARS`, `validatePitch`, or the read-side trim helpers.
- ❌ No agent-side change (zero — `err.error` already works).
- ❌ No librarian-prompt change (`utils__string` exists — `drone-agent/src/plugins/utils.ts`; the error text's advice is valid).
- ❌ No project-wide rollout to insights/principles/other wiki-GET proxies (deferred until after this branch lands).

## Locked design details

### New helper (Q4/Q5/Q9) — `drone-beacon/src/routes/context.ts`

Extract the existing fetch/header logic into one low-level function so the header discipline (ADR 206: Content-Type sent only with a body) is preserved for every caller, then build both the legacy and the detailed proxy on top of it.

```ts
// Low-level coordinator fetch. Returns null when no client is configured;
// THROWS on transport failure and on a non-JSON 2xx body (preserving the
// legacy proxyCall semantics exactly).
async function fetchCoordinator(
  method: string,
  path: string,
  body?: unknown
): Promise<Response | null> {
  const client = getCoordinatorClient();
  if (!client) return null;
  const url = `${client.getBaseUrl()}${coordinatorApiPath(path)}`;
  return coordinatorFetch(url, {
    method,
    headers: body != null ? { 'Content-Type': 'application/json' } : undefined,
    body: body != null ? JSON.stringify(body) : undefined,
  });
}

// UNCHANGED behavior (byte-identical): null on no-client and on non-2xx;
// throws on transport failure and non-JSON 2xx (routes still propagate it).
async function proxyCall(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const res = await fetchCoordinator(method, path, body);
  if (!res || !res.ok) return null;
  return res.json();
}

export const proxyToCoordinator = proxyCall; // insights/principles — unchanged
export const proxyWikiToCoordinator = proxyCall; // remaining wiki GET call sites — unchanged

const ERROR_BODY_MAX_CHARS = 500;

async function readErrorBody(res: Response): Promise<unknown> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return { error: `Coordinator error (HTTP ${res.status})` };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // not JSON — fall through to the text fallback
  }
  const trimmed = text.trim();
  if (!trimmed) return { error: `Coordinator error (HTTP ${res.status})` };
  return { error: trimmed.slice(0, ERROR_BODY_MAX_CHARS) };
}

export interface CoordinatorProxyResult {
  /** True iff a coordinator HTTP response was received (any status). */
  responded: boolean;
  /** Coordinator status (present iff `responded`). */
  status?: number;
  /** Parsed 2xx body, or `{ error }` for a non-2xx body. */
  body?: unknown;
}

/** Detailed proxy: never throws; `responded:false` = no client / transport failure. */
export async function proxyToCoordinatorDetailed(
  method: string,
  path: string,
  body?: unknown
): Promise<CoordinatorProxyResult> {
  let res: Response | null;
  try {
    res = await fetchCoordinator(method, path, body);
  } catch {
    return { responded: false };
  }
  if (!res) return { responded: false };
  if (res.ok) {
    return { responded: true, status: res.status, body: await res.json() };
  }
  return {
    responded: true,
    status: res.status,
    body: await readErrorBody(res),
  };
}
```

### Wiki routes — `drone-beacon/src/routes/wiki.ts`

Import `proxyToCoordinatorDetailed` (keep `proxyWikiToCoordinator` for the untouched GET call sites).

**PUT coordinator branch** (~L110):

```ts
if (scope === 'coordinator') {
  const result = await proxyToCoordinatorDetailed(
    'PUT',
    `/wiki/${pageId}`,
    request.body
  );
  if (!result.responded) {
    return reply.code(502).send({ error: 'Failed to proxy to coordinator' });
  }
  return reply.code(result.status ?? 502).send(result.body);
}
```

**DELETE `scope=coordinator` branch** (~L151):

```ts
if (request.query.scope === 'coordinator') {
  const result = await proxyToCoordinatorDetailed(
    'DELETE',
    `/wiki/${request.params.pageId}`
  );
  if (!result.responded) {
    return reply.code(502).send({ error: 'Failed to proxy to coordinator' });
  }
  const status = result.status ?? 502;
  if (status === 404)
    return reply.code(404).send({ error: 'Wiki page not found' });
  if (status >= 400) return reply.code(status).send(result.body);
  triggerWikiReindex();
  return result.body;
}
```

**DELETE no-scope branch** (~L173, Q8):

```ts
const { deletePage } = await import('drone-swarm-common');
const beaconDeleted = await deletePage(request.params.pageId);
const coordinatorResult = await proxyToCoordinatorDetailed(
  'DELETE',
  `/wiki/${request.params.pageId}`
);
const status = coordinatorResult.status ?? 0;
const coordinatorDeleted =
  coordinatorResult.responded && status >= 200 && status < 300;
const coordinatorErrored =
  !coordinatorResult.responded || (status >= 400 && status !== 404);
// Surface the coordinator's real error only when NOTHING was deleted;
// otherwise keep ADR-206 partial-delete semantics.
if (coordinatorErrored && !beaconDeleted) {
  return coordinatorResult.responded
    ? reply.code(status).send(coordinatorResult.body)
    : reply.code(502).send({ error: 'Failed to proxy to coordinator' });
}
if (!beaconDeleted && !coordinatorDeleted) {
  return reply.code(404).send({ error: 'Wiki page not found' });
}
triggerWikiReindex();
return { success: true, beaconDeleted, coordinatorDeleted };
```

## Steps

1. **`context.ts`** — add `fetchCoordinator`, refactor `proxyCall` to delegate (behavior must stay byte-identical), add `readErrorBody`, `CoordinatorProxyResult`, `proxyToCoordinatorDetailed`, and `ERROR_BODY_MAX_CHARS`. Keep both existing alias exports.
2. **`wiki.ts`** — rewire the PUT and both DELETE coordinator-proxy branches to `proxyToCoordinatorDetailed` per the snippets above. Leave all GET call sites on `proxyWikiToCoordinator`.
3. **`drone-beacon/test/coordinator-proxy.test.ts`** — add tests using the existing `setCoordinatorClient({ getFetch })` seam (real helper path is exercised): coordinator **400** on a coordinator-scope PUT → beacon returns **400 + the exact error body**; transport failure → **502** generic; coordinator 500 on `?scope=coordinator` DELETE → forwards **500 + body** (no longer 404). Keep a regression assertion that `proxyToCoordinator` still returns `null` on a non-2xx (byte-identical guard).
4. **`drone-beacon/test/wiki-origin-reads.test.ts`** — switch the `mockCoordinatorDelete` stub from `proxyWikiToCoordinator` to `proxyToCoordinatorDetailed` (return `{ responded, status, body }`), update the `vi.mock` factory override accordingly, and add: non-JSON error body → `{ error: <text> }`; no-scope DELETE with coordinator 500 **and** a local page → `{ success:true, beaconDeleted:true, coordinatorDeleted:false }` (partial preserved); no-scope DELETE with coordinator 500 and **no** local page → forwards 500 + body.
5. **Build** — `pnpm -r run build` (beacon resolves `drone-swarm-common` from dist, so build before relying on LSP/typecheck).
6. **ADR** — create `/home/unleet/Obsidian/drone-agent-project/decisions/210-beacon-proxy-error-forwarding.md` (Decision: forward upstream status+body verbatim; 502 reserved for no-response; supersedes the "502 = coordinator non-2xx" rule in `drone-agent-swarm-coordinator-proxy-principle`; note the deferred project-wide rollout). Add its row to `decisions/index.md` and bump the count/latest pointer in `index.md`.
7. **Final verification (see criteria).**

## Validation criteria (final step — check the work against ALL of these)

1. **LSP clean** (zero errors/warnings) on every touched file: `context.ts`, `wiki.ts`, `coordinator-proxy.test.ts`, `wiki-origin-reads.test.ts`.
2. **`pnpm -r run build`** exits 0.
3. **`pnpm lint`** exits 0 (repo root; note the project's lint is root `pnpm lint` = `lint:eslint && lint:prettier`, **not** `pnpm -r run lint`). Re-read touched files after linting (prettier reformats).
4. **`pnpm test`** (root fast suite) passes, including the two beacon suites above. `pnpm -r run test` is not the configured fast-suite entry point.
5. **Red-first evidence:** each new regression test fails against pre-fix code and passes post-fix. Specifically, before the fix the 400-case PUT test must show `502 Failed to proxy to coordinator`; after, `400` + `Pitch is too long…`.
6. **End-to-end behavioral check:** the beacon no longer masks coordinator errors on the wiki PUT/DELETE proxy paths, and `proxyToCoordinator` (insights/principles) is behaviorally unchanged (non-2xx → `null`).
7. **Manual smoke** (original repro): a `scope: "coordinator"` `swarm__wiki_write` whose `pitch` exceeds 400 chars now returns the real `Pitch is too long. Keep it under 400 characters…` message (not "Failed to proxy to coordinator"); re-issuing with a ≤400-char pitch succeeds.
8. **ADR present** at `decisions/210-beacon-proxy-error-forwarding.md` with its `decisions/index.md` row and the `index.md` count/pointer bumped.

## Repro command (for criterion 7 / root-cause re-verification)

```bash
cd drone-swarm-common && node --input-type=module -e '
import { writePage, setKnowledgeBaseDir } from "./dist/index.js";
import os from "node:os"; import path from "node:path"; import fs from "node:fs/promises";
setKnowledgeBaseDir(await fs.mkdtemp(path.join(os.tmpdir(), "kb-")));
try { await writePage("p","T","coordinator","# body",[],[],"x".repeat(401)); }
catch (e) { console.log(e.message); }   // "Pitch is too long. Keep it under 400 characters ..."
'
```

## Notes / gotchas

- `proxyCall` must stay byte-identical: `null` on no-client **and** on non-2xx; **throw** on transport failure and on a non-JSON 2xx body (`res.json()` still throws). Only `proxyToCoordinatorDetailed` swallows the transport failure.
- The `Content-Type` header must keep being sent only together with a body (ADR 206 — `FST_ERR_CTP_EMPTY_JSON_BODY`).
- `drone-beacon/test/routes.test.ts` PUTs are personas/skills/memory/config — untouched.
- Per AGENTS.md, commit `.drone-agent` memories/insights/principles with the changes on this feature branch; do not commit memory-only changes to `main`.

---

## ✅ COMPLETED 2026-09-17 (commit 849f2c8, branch feat/coordinator-config-ui-and-secure-storage)

All 7 steps executed; every validation criterion satisfied. This was fixed in place on the
existing feature branch, with the smallest change that resolves the reported bug.

### What shipped

1. **`drone-beacon/src/routes/context.ts`** — extracted `fetchCoordinator(method, path, body)`
   (returns `Response | null`; null when no client; throws on transport failure), preserving
   the ADR-206 header discipline. `proxyCall` refactored to delegate to it and kept
   **byte-identical** (`null` on no-client and non-2xx; throws on transport failure and on a
   non-JSON 2xx body). Added `ERROR_BODY_MAX_CHARS = 500`, `readErrorBody` (JSON object
   passes through verbatim; otherwise `{ error: <trimmed text, truncated> }`),
   `CoordinatorProxyResult` (`{ responded, status?, body? }`), and
   `proxyToCoordinatorDetailed` (never throws; `responded:false` = no coordinator response).
2. **`drone-beacon/src/routes/wiki.ts`** — the `PUT` coordinator branch and both `DELETE`
   branches now consume `proxyToCoordinatorDetailed`: forward the coordinator's real status +
   body; `502 Failed to proxy to coordinator` strictly means "no coordinator response".
   No-scope DELETE preserves ADR-206 partial-delete semantics (the real error is forwarded
   only when nothing was deleted; a successful local delete still returns
   `{ success:true, beaconDeleted:true, coordinatorDeleted:false }`). All GET call sites
   left on `proxyWikiToCoordinator`.
3. **Tests** — `drone-beacon/test/coordinator-proxy.test.ts` +5 (400 forwarded with body;
   transport → generic 502; DELETE 500 forwarded instead of 404; DELETE 404 still mapped;
   `proxyToCoordinator` still collapses non-2xx to `null`). `drone-beacon/test/wiki-origin-reads.test.ts`
   stub repointed to `proxyToCoordinatorDetailed` (returns `{ responded, status, body }`) and
   +4 (non-JSON error body → `{ error }`; no-scope partial preserved on coordinator 500;
   no-scope forwards the error when nothing was deleted; unreachable → generic 502).
4. **ADR** — `decisions/210-beacon-proxy-error-forwarding.md`, its `decisions/index.md` row,
   and `index.md` count 208 → 210 + latest pointer.

### Validation results

- LSP clean on all four touched files; `pnpm -r run build` exit 0 (re-run after prettier);
  `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm test` 3053 passed / 14 skipped, exit 0.
- **Red-first evidence**: with only the two source files stashed (tests kept), 11 of 39 tests
  failed — including the key PUT case `expected 502 to be 400`, exactly the predicted masking
  symptom. Fix restored (byte-compared against saved copies) and all 39 pass.
- **E2E smoke**: a temporary test drove a real HTTP round trip through the actual
  `createCoordinatorFetch` path to a live coordinator-shaped server — the coordinator saw
  `PUT /api/wiki/smoke-page` and the beacon relayed its `400` with the exact error body
  (temp test removed after the run).

### Deviations / findings

- **Closed a pre-existing index gap**: ADR file `209-stored-secrets-config-split.md` had no
  row in `decisions/index.md` (210 files vs 209 indexed). Since this change asserts
  "All 210 … live in [[decisions/index]]", the 209 row was added to make that true.
- `prettier` (run via `pnpm lint`) reformatted the four touched files plus three
  `.drone-agent` files — cosmetic only (line wrapping, table alignment, markdown italics,
  trailing newline). Build/typecheck were re-run afterwards.
- One `apply_diff` hunk mis-anchored the `mockReset` into the wrong `describe` block,
  producing a spy-leak test failure; corrected by moving it to the delete-scope block.
